package routes

// Share to Google Docs, slice C of #20010: one background loop keeps every shared Doc in step with its artifact, and the one place a Doc is written (pushGdoc), which a press
// of Share uses too. Off with the switch (a pass does nothing, no Google call, no keychain read), paused per Doc by the owner, never overwrites a Doc edited in Google since the
// last sync (the Doc is kept and the new version goes to a new Doc: keep both), backs off on 429, at most gdocWritesPerHour changes to one Doc an hour, and every outgoing text
// is redacted and capped. The token comes only from the token source (the keychain, or the sealed sign-in) and is never printed.

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/gdocsync"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
)

const (
	gdocWritesPerHour = 20
	gdocBackoffFirst  = time.Minute
	gdocBackoffMax    = 30 * time.Minute
)

var (
	errGdocRate   = errors.New("gdoc: too many changes to this Doc in the last hour")
	errGdocPaused = errors.New("gdoc: syncing this Doc is paused")
	errGdocRedact = errors.New("gdoc: the text could not be checked for secrets")
)

func gdocURL(docID string) string { return "https://docs.google.com/document/d/" + docID + "/edit" }

// gdocLimiter keeps the changes made to each Doc in the last hour (in memory: a restart gives a fresh hour, which is the looser side only by the 20 the hour allows).
type gdocLimiter struct {
	mu sync.Mutex
	at map[string][]time.Time
}

var gdocWrites = &gdocLimiter{at: map[string][]time.Time{}}

// allow records a change to the Doc and says whether it is within the hour's bound.
func (l *gdocLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	keep := l.at[key][:0]
	for _, t := range l.at[key] {
		if now.Sub(t) < time.Hour {
			keep = append(keep, t)
		}
	}
	if len(keep) >= gdocWritesPerHour {
		l.at[key] = keep
		return false
	}
	l.at[key] = append(keep, now)
	return true
}

type gdocPushResult struct {
	DocID    string
	Created  bool   // a new Doc was made (the first share, or a kept-both)
	Requests int    // the changes sent to an existing Doc
	Kept     string // the earlier Doc, when the Doc had been edited in Google and the new version went to a new Doc
}

// pushGdoc is the only place a Doc is written. It redacts and caps the text, honours a pause (the loop's call; a press of Share is the owner resuming it only through Resume), keeps
// the per-Doc hour bound, and on a Doc edited in Google since the last sync leaves it as it is and makes a new Doc from this version.
func (h *SessionsHandler) pushGdoc(ctx context.Context, c *gdocsync.Client, key string, md []byte, digest, name string, auto bool) (gdocPushResult, error) {
	if len(md) > gdocMaxMarkdown {
		return gdocPushResult{}, errors.New("gdoc: the file is too large")
	}
	red, err := secrets.Redactor().Text(md)
	if err != nil {
		return gdocPushResult{}, errGdocRedact // fail closed: nothing unchecked leaves this computer
	}
	gdocShareMu.Lock()
	defer gdocShareMu.Unlock()
	existing, err := h.ss.GetGdocShare(ctx, key)
	if err != nil {
		return gdocPushResult{}, err
	}
	if existing != nil && existing.State == store.GdocSharePaused {
		return gdocPushResult{}, errGdocPaused
	}
	now := time.Now()
	save := func(g store.GdocShare) error {
		g.Key, g.Digest, g.Name, g.SyncedAt = key, digest, name, now.UTC().Format(time.RFC3339)
		return h.ss.SaveGdocShare(ctx, g, now)
	}
	newDoc := func(kept string) (gdocPushResult, error) {
		title := name
		if kept != "" {
			title = name + " (from Coral)"
		}
		docID, err := c.Push(ctx, title, string(red))
		if err != nil {
			return gdocPushResult{}, err
		}
		_, rev, _ := c.Read(ctx, docID) // the revision the next sync compares with; unknown is fine (the next sync takes the Doc as it is)
		if err := save(store.GdocShare{DocID: docID, DocRevision: rev, ConflictDoc: kept}); err != nil {
			return gdocPushResult{}, err
		}
		return gdocPushResult{DocID: docID, Created: true, Kept: kept}, nil
	}
	if existing == nil {
		return newDoc("")
	}
	if !gdocWrites.allow(key, now) {
		return gdocPushResult{}, errGdocRate
	}
	n, rev, err := c.PatchSince(ctx, existing.DocID, string(red), existing.DocRevision)
	switch {
	case err == nil:
		if err := save(store.GdocShare{DocID: existing.DocID, DocRevision: rev, ConflictDoc: existing.ConflictDoc}); err != nil {
			return gdocPushResult{}, err
		}
		return gdocPushResult{DocID: existing.DocID, Requests: n}, nil
	case errors.Is(err, gdocsync.ErrEditedSinceSync) || errors.Is(err, gdocsync.ErrDocChanged):
		slog.Info("[gdoc] a shared Doc was edited in Google since the last sync: it is kept as it is and the new version went to a new Doc", "auto", auto)
		return newDoc(existing.DocID)
	default:
		return gdocPushResult{}, err
	}
}

// gdocSyncState is what the loop keeps between passes: the 429 backoff.
type gdocSyncState struct {
	until time.Time
	wait  time.Duration
}

// GdocSyncRun is the one background loop for every shared Doc: a pass each interval (and none while the switch is off).
func (h *SessionsHandler) GdocSyncRun(ctx context.Context, every time.Duration) {
	st := &gdocSyncState{}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.gdocSyncPass(ctx, st, time.Now())
		}
	}
}

// gdocSyncPass pushes each live share's newest version when it is not the one in its Doc. Nothing happens while the switch is off (no Google call, no keychain read).
func (h *SessionsHandler) gdocSyncPass(ctx context.Context, st *gdocSyncState, now time.Time) {
	settings, err := h.ss.GetSettings(ctx)
	if err != nil || !gdocSwitchOn(settings) || !gdocMac() || now.Before(st.until) {
		return
	}
	shares, err := h.ss.ListGdocShares(ctx)
	if err != nil || len(shares) == 0 {
		return
	}
	var c *gdocsync.Client
	for _, sh := range shares {
		if ctx.Err() != nil {
			return
		}
		if sh.State != store.GdocShareLive {
			continue
		}
		members := seriesMembers(h.cfg.CoralDir(), sh.Key)
		if len(members) == 0 || members[len(members)-1].Digest == sh.Digest {
			continue // a file with no series, or nothing new
		}
		latest := members[len(members)-1]
		md, name, ok := h.gdocReadVersion(latest.Digest)
		if !ok {
			continue
		}
		if c == nil {
			if c, err = gdocClientFor(); err != nil {
				return
			}
			if _, err := c.TokenFunc(); err != nil {
				return // not signed in: nothing to do, and nothing is said every pass
			}
		}
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		_, err := h.pushGdoc(cctx, c, sh.Key, md, latest.Digest, name, true)
		cancel()
		switch {
		case err == nil, errors.Is(err, errGdocPaused), errors.Is(err, errGdocRate):
		case gdocsync.IsRateLimited(err):
			if st.wait == 0 {
				st.wait = gdocBackoffFirst
			} else if st.wait *= 2; st.wait > gdocBackoffMax {
				st.wait = gdocBackoffMax
			}
			st.until = now.Add(st.wait)
			slog.Warn("[gdoc] Google asked to slow down; the sync waits", "for", st.wait.String())
			return
		case errors.Is(err, gdocsync.ErrOutcomeUnknown):
			// The change may or may not have been made: pause this Doc until the owner has looked at it, rather than send it again on a guess.
			_, _ = h.ss.SetGdocShareState(ctx, sh.Key, store.GdocSharePaused)
			slog.Warn("[gdoc] a change to a shared Doc may or may not have been made; syncing that Doc is paused until the owner resumes it")
		default:
			slog.Warn("[gdoc] a shared Doc could not be updated", "kind", gdocErrKind(err))
		}
		if err == nil {
			st.wait = 0
		}
	}
}

// gdocErrKind names a failure for the log without its text (a Google body could carry something).
func gdocErrKind(err error) string {
	switch {
	case errors.Is(err, errGdocRedact):
		return "redact"
	case errors.Is(err, gdocsync.ErrDocChanged):
		return "changed"
	default:
		return "failed"
	}
}

// gdocReadVersion reads one stored version's Markdown for the sync: the digest is a stored object's 64-hex name (never a request path), a regular file, capped, Markdown only.
func (h *SessionsHandler) gdocReadVersion(digest string) ([]byte, string, bool) {
	if !validArtifactID(digest) {
		return nil, "", false
	}
	path := filepath.Join(h.artifactDir(), digest)
	meta, ok := readSidecar(path + ".json")
	if !ok || !(len(meta.MediaType) >= 13 && meta.MediaType[:13] == "text/markdown" || filepath.Ext(meta.Name) == ".md") {
		return nil, "", false
	}
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > gdocMaxMarkdown {
		return nil, "", false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, "", false
	}
	name := meta.Name
	if name == "" {
		name = "Coral artifact"
	}
	return b, name, true
}
