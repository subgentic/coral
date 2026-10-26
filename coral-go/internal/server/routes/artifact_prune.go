package routes

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Artifact retention and pruning (#3554, design note v3). What can go:
//   - diffs: a task's changes.diff once the task is completed or skipped, and a session's once
//     the session is stopped (never a running or sleeping one), older than the threshold;
//   - objects: an artifact object no post, task, note, panel, workflow or knowledge file links,
//     that isn't kept, and whose newest upload is older than the threshold;
//   - diff-objects: the shared copies behind diffs (#3555) that no diff links any more.
//
// Shrink rewrites closed diffs through #3555's filter instead (the text changes stay). Nothing
// is removed unless the Operator runs it (or turns on retention); a reference scan that fails
// removes nothing.
const (
	pruneKindDiffs       = "diffs"
	pruneKindObjects     = "objects"
	pruneKindDiffObjects = "diff-objects"

	pruneScanTimeout   = 30 * time.Second
	pruneRunTimeout    = 5 * time.Minute
	pruneLargest       = 20
	pruneMinOlderThan  = 24 * time.Hour // a prune of anything younger is refused (a typo guard)
	diffObjectGrace    = time.Hour      // a diff object this young may be about to be linked
	pruneDiffReadLimit = 512 << 20      // a stored diff bigger than this isn't shrunk
)

// A long object prune scans the references again every pruneRescanEvery deletions, and at least
// every pruneRescanAfter (Security's #3554 review). Vars so a test can make them small.
var (
	pruneRescanEvery = 100
	pruneRescanAfter = 30 * time.Second
)

// pruneAfterDeleteHook lets a test post a link after each object deletion.
var pruneAfterDeleteHook func()

// pruneRunning: one prune or shrink at a time.
var pruneRunning sync.Mutex

type pruneOptions struct {
	OlderThan time.Duration
	Kinds     map[string]bool
	DryRun    bool
	Shrink    bool
	MaxBytes  int64 // stop once this much is freed (retention's per-run cap); 0: no cap
	Now       time.Time
}

type pruneItem struct {
	Kind    string  `json:"kind"`
	ID      string  `json:"id"`
	Name    string  `json:"name,omitempty"`
	Board   string  `json:"board,omitempty"`
	Bytes   int64   `json:"bytes"`
	AgeDays float64 `json:"age_days"`
}

type pruneTotal struct {
	Count int   `json:"count"`
	Bytes int64 `json:"bytes"`
}

// pruneReport is what a prune or shrink did, or (dry run) would do.
type pruneReport struct {
	DryRun           bool                   `json:"dry_run"`
	Shrink           bool                   `json:"shrink"`
	OlderThanSeconds int64                  `json:"older_than_seconds"`
	Kinds            map[string]*pruneTotal `json:"kinds"`
	ByBoard          map[string]int64       `json:"by_board"`
	Largest          []pruneItem            `json:"largest"`
	Freed            int64                  `json:"freed"`   // bytes freed on disk (would be, for a dry run)
	Removed          int                    `json:"removed"` // items removed or rewritten
	Skipped          int                    `json:"skipped"` // changed since the scan: left alone
	Errors           int                    `json:"errors"`
	Capped           bool                   `json:"capped,omitempty"`
	ScanMillis       int64                  `json:"scan_ms"`
}

func newPruneReport(o pruneOptions) *pruneReport {
	return &pruneReport{DryRun: o.DryRun, Shrink: o.Shrink, OlderThanSeconds: int64(o.OlderThan / time.Second),
		Kinds: map[string]*pruneTotal{}, ByBoard: map[string]int64{}}
}

func (r *pruneReport) add(it pruneItem) {
	t := r.Kinds[it.Kind]
	if t == nil {
		t = &pruneTotal{}
		r.Kinds[it.Kind] = t
	}
	t.Count++
	t.Bytes += it.Bytes
	board := it.Board
	if board == "" {
		board = "(none)"
	}
	r.ByBoard[board] += it.Bytes
	r.Largest = append(r.Largest, it)
}

func (r *pruneReport) finish() {
	sort.SliceStable(r.Largest, func(i, j int) bool { return r.Largest[i].Bytes > r.Largest[j].Bytes })
	if len(r.Largest) > pruneLargest {
		r.Largest = r.Largest[:pruneLargest]
	}
}

// ── References ──────────────────────────────────────────────────────

// ── Kept artifacts ──────────────────────────────────────────────────

// ── Candidates ──────────────────────────────────────────────────────

var sqlNoRows = sql.ErrNoRows

func parseDBTime(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unparsed time %q", s)
}

// ── The run ─────────────────────────────────────────────────────────

// runPrune prunes or shrinks as o says. A reference scan that fails fails the run before
// anything is removed.
func (h *SessionsHandler) runPrune(ctx context.Context, o pruneOptions) (*pruneReport, error) {
	if !pruneRunning.TryLock() {
		return nil, errPruneBusy
	}
	defer pruneRunning.Unlock()
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	rep := newPruneReport(o)
	coralDir := h.cfg.CoralDir()
	capped := func() bool {
		if o.MaxBytes > 0 && rep.Freed >= o.MaxBytes {
			rep.Capped = true
			return true
		}
		return false
	}

	if o.Shrink {
		diffs, err := h.closedDiffs(ctx, o)
		if err != nil {
			return nil, err
		}
		h.shrinkDiffs(ctx, o, diffs, rep)
		if !o.DryRun {
			h.sweepDiffObjects(o, rep, capped)
			invalidateStorageDetail()
		}
		rep.finish()
		return rep, nil
	}

	if o.Kinds[pruneKindDiffs] {
		diffs, err := h.closedDiffs(ctx, o)
		if err != nil {
			return nil, err
		}
		h.pruneDiffs(ctx, o, diffs, rep, capped)
	}

	if o.Kinds[pruneKindObjects] && !capped() {
		start := time.Now()
		refs, err := h.scanArtifactReferences(ctx)
		rep.ScanMillis = time.Since(start).Milliseconds()
		if err != nil {
			slog.Warn("[artifacts] prune: the reference scan failed, so no artifact object is removed", "error", err)
			return nil, fmt.Errorf("the reference scan failed (nothing removed): %w", err)
		}
		kept, err := h.protectedArtifacts(ctx)
		if err != nil {
			return nil, fmt.Errorf("could not read kept artifacts (nothing removed): %w", err)
		}
		cands, err := h.objectCandidates(ctx, o, refs, kept)
		if err != nil {
			return nil, err
		}
		if pruneAfterCandidatesHook != nil {
			pruneAfterCandidatesHook()
		}
		if !o.DryRun && len(cands) > 0 {
			// A link posted since the first scan keeps its object: scan again right before
			// deleting, then re-check each candidate under its digest lock.
			if refs, err = h.scanArtifactReferences(ctx); err != nil {
				slog.Warn("[artifacts] prune: the reference re-scan failed, so no artifact object is removed", "error", err)
				return nil, fmt.Errorf("the reference re-scan failed (nothing removed): %w", err)
			}
		}
		scanAt := time.Now()
		sinceScan := 0
		for _, c := range cands {
			if capped() {
				break
			}
			// A long run looks again every 100 deletions or 30 s, so a link posted meanwhile is seen.
			if !o.DryRun && (sinceScan >= pruneRescanEvery || time.Since(scanAt) >= pruneRescanAfter) {
				if refs, err = h.scanArtifactReferences(ctx); err != nil {
					slog.Warn("[artifacts] prune: a reference re-scan failed, so the run stops here", "error", err)
					rep.Errors++
					break
				}
				scanAt, sinceScan = time.Now(), 0
			}
			it := pruneItem{Kind: pruneKindObjects, ID: c.id, Name: c.name, Bytes: c.bytes, AgeDays: o.Now.Sub(c.use).Hours() / 24}
			if o.DryRun {
				rep.add(it)
				rep.Freed += c.bytes
				continue
			}
			freed, ok, err := h.deleteObjectIfStillUnused(ctx, coralDir, c.id, o, refs, scanAt)
			switch {
			case err != nil:
				rep.Errors++
			case !ok:
				rep.Skipped++
			default:
				rep.add(it)
				rep.Freed += freed
				rep.Removed++
				sinceScan++
				slog.Info("[artifacts] pruned an artifact object", "digest", c.id, "bytes", freed)
				if pruneAfterDeleteHook != nil {
					pruneAfterDeleteHook()
				}
			}
		}
	}

	if (o.Kinds[pruneKindDiffObjects] || o.Kinds[pruneKindDiffs]) && !o.DryRun {
		h.sweepDiffObjects(o, rep, capped)
	} else if o.Kinds[pruneKindDiffObjects] && o.DryRun {
		h.sweepDiffObjects(o, rep, capped) // dry: only counts
	}
	rep.finish()
	if !o.DryRun {
		invalidateStorageDetail()
	}
	return rep, nil
}

var errPruneBusy = errors.New("a prune or shrink is already running")

// pruneAfterCandidatesHook lets a test post a link between the first scan and the deletion.
var pruneAfterCandidatesHook func()

// pruneBeforeDiffHook lets a test reopen a task between the listing and acting on its diff.
var pruneBeforeDiffHook func(diffCandidate)

// deleteObjectIfStillUnused re-checks a candidate under its digest lock (an upload or
// auto-attach of the same bytes holds the same lock) and deletes it only if it is still old,
// unreferenced and not kept.
func (h *SessionsHandler) deleteObjectIfStillUnused(ctx context.Context, coralDir, id string, o pruneOptions, refs map[string]bool, scanAt time.Time) (int64, bool, error) {
	defer lockArtifact(id)()
	if refs[id] {
		return 0, false, nil
	}
	if kept, err := h.isProtected(ctx, id); err != nil || kept {
		return 0, false, err
	}
	use := objectNewestUse(coralDir, id, newestRecordFor(coralDir, id))
	if o.Now.Sub(use) < o.OlderThan || use.After(scanAt) {
		return 0, false, nil // uploaded again meanwhile
	}
	freed, _, found, err := deleteArtifactFilesLocked(coralDir, id)
	if !found {
		return 0, false, nil
	}
	if err == nil {
		h.dropArtifactComments(ctx, id)
	}
	return freed, err == nil, err
}

// newestRecordFor reads one artifact's upload records only.
func newestRecordFor(coralDir, id string) map[string]time.Time {
	if !objectNameRe.MatchString(id) { // an id read from a file or a message is a 64-digit hex name before it is joined onto a folder (#5305)
		return nil
	}
	out := map[string]time.Time{}
	sessions, err := os.ReadDir(filepath.Join(coralDir, "artifacts", "uploads"))
	if err != nil {
		return out
	}
	for _, s := range sessions {
		up := uploadsDir(coralDir, s.Name())
		if up == "" || !s.IsDir() {
			continue
		}
		p := filepath.Join(up, id+".json")
		if _, err := os.Lstat(p); err == nil {
			if t := recordTime(p); t.After(out[id]) {
				out[id] = t
			}
		}
	}
	return out
}

// ── Routes ──────────────────────────────────────────────────────────
