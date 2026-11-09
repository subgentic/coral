package routes

// Dropbox stage 4b, retention (#14703; design v33 §4c and the stage 4b delta v2): "Keep in Dropbox for N days", off by default and the Operator's.
// It deletes only the files this Coral stored in the account connected now (the outbox's done rows), only under /v1/, by Coral's own artifact time,
// by path with the rev Coral stored (parent_rev: Dropbox refuses a file edited there), a version and its sidecar together, at most 100 files and never
// more than half the ledger a pass, and nothing when the clock is behind the last pass or more than a day off Dropbox's. The local copy is never
// touched. Every pass writes an audit row with counts and bytes only.

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/store"
)

const (
	dropboxRetainMax   = 100            // files a pass, at most
	dropboxRetainSkew  = 24 * time.Hour // the local clock may be this far off Dropbox's
	dropboxRetainFetch = 5000           // due rows read a pass (the rest are counted as held next time)
)

// retentionPlan is what a pass would delete now.
type retentionPlan struct {
	take   []store.LedgerRow
	bytes  int64
	held   int // due, left for a later pass by the ceiling or a hook
	ledger int // the account's done rows
}

// planRetention picks whole pairs (a version and its sidecar) of the account's due rows, oldest first, up to the ceiling.
func (b *DropboxBackup) planRetention(ctx context.Context, account string, days int, now time.Time) (retentionPlan, error) {
	var p retentionPlan
	n, err := b.outbox.LedgerSize(ctx, account)
	if err != nil {
		return p, err
	}
	p.ledger = n
	ceiling := min(dropboxRetainMax, n/2) // a ledger of one file never deletes (Security's point 7)
	due, err := b.outbox.DueForRetention(ctx, account, now.Add(-time.Duration(days)*24*time.Hour), dropboxRetainFetch)
	if err != nil {
		return p, err
	}
	for i := 0; i < len(due); {
		j := i + 1
		for j < len(due) && due[j].DocID == due[i].DocID && due[j].Version == due[i].Version && due[j].Digest == due[i].Digest {
			j++
		}
		pair := due[i:j]
		i = j
		if !strings.HasPrefix(pair[0].Path, "/v1/") || b.keepDoc(ctx, pair[0].DocID, pair[0].Version) || len(p.take)+len(pair) > ceiling {
			p.held += len(pair)
			continue
		}
		for _, r := range pair {
			p.take = append(p.take, r)
			p.bytes += r.Size
		}
	}
	return p, nil
}

// RetentionPreview is the dry run: what the next pass would delete at days, without saving or calling Dropbox.
func (b *DropboxBackup) RetentionPreview(ctx context.Context, days int) (count int, bytes int64, held, ledger int, err error) {
	c, err := b.d.store.Get(ctx)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	if !c.Connected || days <= 0 {
		return 0, 0, 0, 0, nil
	}
	_, _ = b.outbox.StampAccount(ctx, c.AccountID)
	p, err := b.planRetention(ctx, c.AccountID, days, b.now())
	return len(p.take), p.bytes, p.held, p.ledger, err
}

// Retain runs one retention pass when the Operator turned retention on, at most once an hour.
func (b *DropboxBackup) Retain(ctx context.Context) {
	b.passMu.Lock()
	defer b.passMu.Unlock()
	days, last, err := b.d.store.Retention(ctx)
	if err != nil || days <= 0 || b.d.appKey() == "" || b.d.looksLikeCopy(ctx) {
		return
	}
	c, err := b.d.store.Get(ctx)
	if err != nil || !c.Connected || c.AccountID == "" || c.State == store.DropboxStateReconnect { // quota_full runs: freeing space is the point
		return
	}
	if battery, metered := b.power(); battery || metered {
		return
	}
	now := b.now()
	if !b.lastRetain.IsZero() && now.Sub(b.lastRetain) < b.retainEvery && !now.Before(b.lastRetain) {
		return
	}
	refuse := func(reason string) {
		b.lastRetain = now // one refusal an hour, not one a pass
		_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditPass, NewDays: days, Reason: reason})
		slog.Info("[dropbox] retention deleted nothing", "state", reason)
	}
	if lt, perr := time.Parse(time.RFC3339, last); last != "" && perr == nil && now.Before(lt) {
		refuse("clock_behind")
		return
	}
	refresh, err := b.d.store.RefreshToken(ctx)
	if err != nil {
		return
	}
	cl := b.d.client(b.d.appKey())
	access, err := cl.Refresh(ctx, refresh)
	if errors.Is(err, dropbox.ErrInvalidGrant) {
		_ = b.d.store.SetState(ctx, store.DropboxStateReconnect)
		return
	}
	if err != nil {
		return
	}
	_, _, theirs, err := cl.SpaceUsageAt(ctx, access)
	if err != nil {
		return
	}
	if theirs.IsZero() || now.Sub(theirs) > dropboxRetainSkew || theirs.Sub(now) > dropboxRetainSkew {
		refuse("clock_skew")
		return
	}
	b.lastRetain = now
	_ = b.d.store.SetRetentionPass(ctx, now.UTC().Format(time.RFC3339))
	_, _ = b.outbox.StampAccount(ctx, c.AccountID)

	deleted, bytes := 0, int64(0)
	apply := func(rows []store.LedgerRow, res []dropbox.DeleteOutcome) {
		for i, r := range rows {
			state := store.DropboxOutboxDoneS
			switch res[i] {
			case dropbox.DeleteOK:
				state = store.DropboxOutboxRetainedOut
				deleted++
				bytes += r.Size
			case dropbox.DeleteNotFound:
				state = store.DropboxOutboxGone
			case dropbox.DeleteRefused:
				state = store.DropboxOutboxEdited
			}
			_ = b.outbox.MarkRetention(ctx, r.ID, state)
		}
	}
	// A job a pass left running is read first; its rows are never put in a second job (Security's point 8).
	jobs, err := b.outbox.Deleting(ctx, c.AccountID)
	if err != nil {
		return
	}
	for job, rows := range jobs {
		done, res, err := cl.DeleteBatchCheck(ctx, access, job, len(rows))
		if errors.Is(err, dropbox.ErrJobUnknown) {
			for _, r := range rows {
				_ = b.outbox.MarkRetention(ctx, r.ID, store.DropboxOutboxDoneS) // looked at again on a later pass, by path and rev
			}
			continue
		}
		if err == nil && done {
			apply(rows, res)
		}
	}

	p, err := b.planRetention(ctx, c.AccountID, days, now)
	if err != nil {
		return
	}
	defer func() {
		_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditPass, NewDays: days, Count: deleted, Bytes: bytes, Held: p.held})
		slog.Info("[dropbox] retention pass", "files", deleted, "bytes", bytes)
	}()
	if len(p.take) == 0 {
		return
	}
	slog.Info("[dropbox] retention: files due", "files", len(p.take))
	dels := make([]dropbox.Delete, len(p.take))
	ids := make([]int64, len(p.take))
	for i, r := range p.take {
		dels[i] = dropbox.Delete{Path: r.Path, Rev: r.Rev}
		ids[i] = r.ID
	}
	job, res, err := cl.DeleteBatch(ctx, access, dels)
	if err != nil {
		return // a rate limit or a refusal: nothing changed, tried on a later pass
	}
	if job == "" {
		apply(p.take, res)
		return
	}
	if err := b.outbox.MarkDeleting(ctx, ids, job); err != nil {
		return
	}
	for waited := time.Duration(0); waited < b.retainWait; waited += b.retainPoll {
		select {
		case <-ctx.Done():
			return
		case <-time.After(b.retainPoll):
		}
		done, res, err := cl.DeleteBatchCheck(ctx, access, job, len(p.take))
		if err != nil && !errors.Is(err, dropbox.ErrJobUnknown) {
			continue
		}
		if errors.Is(err, dropbox.ErrJobUnknown) {
			for _, r := range p.take {
				_ = b.outbox.MarkRetention(ctx, r.ID, store.DropboxOutboxDoneS)
			}
			return
		}
		if done {
			apply(p.take, res)
			return
		}
	}
	// Still running: the rows stay deleting with the job's id, and the next pass reads its answer.
}
