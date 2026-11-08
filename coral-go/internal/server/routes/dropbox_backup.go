package routes

// Dropbox stage 4, the upload worker (#14655; design v33 and the stage 4 delta v2 with Security's changes a-f). Every agent upload queues two files in
// the outbox: the artifact's bytes at /v1/<hhh>/<doc_id>/v<n>-<d8>.<ext> and its item_data sidecar beside it (ids only in paths; the extension from a
// closed map). A pass, run in the background, sends what is due: only when Dropbox is connected, this data folder is not a copy, an app key is set and
// the state is not reconnect or quota_full (checked again before each batch commit); not on battery or a metered network; not when the account is at
// 90% of its space; never a private artifact (an unreadable mark sends nothing); never over a file already there (a conflict is parked). Up to four
// sessions at a time and 64 MB in flight. Logs carry counts and state words only.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
)

const (
	dropboxBatchRows   = 500
	dropboxInFlight    = 64 << 20
	dropboxParallel    = 4
	dropboxItemDataMax = 4 << 10
	dropboxValueMax    = 128
	dropboxObjectMax   = 65 << 20
)

// dropboxExt is the closed map from media type to extension (design §4): everything else is .bin, so nothing in the backup opens as active content.
var dropboxExt = map[string]string{
	"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf",
	"text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/json": "json", "video/mp4": "mp4",
}

var dropboxTextExt = map[string]bool{"md": true, "txt": true, "json": true, "csv": true}

func dropboxExtOf(mediaType string) string {
	mt := strings.TrimSpace(strings.SplitN(mediaType, ";", 2)[0])
	if e, ok := dropboxExt[strings.ToLower(mt)]; ok {
		return e
	}
	return "bin"
}

// DropboxBackup is the worker for one data folder.
type DropboxBackup struct {
	d        *dropboxRoutes
	outbox   *store.DropboxOutbox
	coralDir string

	private  func(ctx context.Context, ids []string) (map[string]bool, error) // the private marks; nil reads none (tests set it)
	types    func() map[string]bool                                           // the chosen types; nil or empty is every type
	maxAge   func() time.Duration                                             // only artifacts newer than this; 0 is no limit
	power    func() (onBattery, metered bool)
	secret   func([]byte) bool
	now      func() time.Time
	parallel int

	passMu sync.Mutex
	kick   chan struct{} // an upload asks for a pass soon
}

var (
	dropboxBackupsMu sync.Mutex
	dropboxBackups   = map[string]*DropboxBackup{} // by data folder, so a test's store never feeds another's outbox
)

// NewDropboxBackup makes the worker for the handler's Dropbox sign-in and hooks it to this data folder's uploads and deletes.
func (h *CloudHandler) NewDropboxBackup(ob *store.DropboxOutbox) *DropboxBackup {
	_ = secrets.Init()
	b := &DropboxBackup{d: h.dbx, outbox: ob, coralDir: h.dbx.dataDir, power: osPower, now: time.Now, parallel: dropboxParallel, kick: make(chan struct{}, 1),
		private: func(context.Context, []string) (map[string]bool, error) {
			return nil, errors.New("no private marks to read")
		}, // fail closed until SetPrivate
		secret: func(data []byte) bool {
			out, err := secrets.Redactor().Text(data)
			return err == nil && !bytes.Equal(out, data)
		}}
	// The Operator's filters from the store (the defaults are every type and every age).
	b.types = func() map[string]bool {
		types, _, err := b.d.store.Filters(context.Background())
		if err != nil || len(types) == 0 {
			return nil
		}
		m := map[string]bool{}
		for _, t := range types {
			m[t] = true
		}
		return m
	}
	b.maxAge = func() time.Duration {
		_, days, err := b.d.store.Filters(context.Background())
		if err != nil || days <= 0 {
			return 0
		}
		return time.Duration(days) * 24 * time.Hour
	}
	h.dbx.outbox = ob
	dropboxBackupsMu.Lock()
	dropboxBackups[filepath.Clean(b.coralDir)] = b
	dropboxBackupsMu.Unlock()
	return b
}

// SetPrivate gives the worker the board's private marks (board.Store.PrivateArtifacts).
func (b *DropboxBackup) SetPrivate(f func(ctx context.Context, ids []string) (map[string]bool, error)) {
	if f != nil {
		b.private = f
	}
}

// Run is the worker's loop: one backfill, then a pass every interval, or soon after an upload asks for one, until ctx ends.
func (b *DropboxBackup) Run(ctx context.Context, every time.Duration) {
	b.Backfill(ctx)
	b.Pass(ctx)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-b.kick:
		}
		b.Pass(ctx)
	}
}

func dropboxBackupFor(coralDir string) *DropboxBackup {
	dropboxBackupsMu.Lock()
	defer dropboxBackupsMu.Unlock()
	return dropboxBackups[filepath.Clean(coralDir)]
}

// noteDropboxUpload queues an upload record's files. Called after the record is stored, outside the artifact's lock; it never fails the upload.
func noteDropboxUpload(coralDir, session, digest string) {
	b := dropboxBackupFor(coralDir)
	if b == nil {
		return
	}
	rec, ok := readUploadRecord(coralDir, session, digest)
	if !ok {
		return
	}
	if err := b.enqueue(context.Background(), digest, rec); err != nil {
		slog.Warn("[dropbox] an upload was not queued for the backup; the next backfill queues it")
		return
	}
	select {
	case b.kick <- struct{}{}:
	default:
	}
}

// noteDropboxDelete cancels the queued files of a deleted artifact (Security's change b): it is never uploaded afterwards.
func noteDropboxDelete(coralDir, digest string) {
	if b := dropboxBackupFor(coralDir); b != nil {
		_, _ = b.outbox.CancelDigest(context.Background(), digest)
	}
}

func (b *DropboxBackup) enqueue(ctx context.Context, digest string, rec agentUploadRecord) error {
	doc := docIDOf(rec)
	if !seriesIDRe.MatchString(doc) || !objectNameRe.MatchString(digest) {
		return nil // no document id yet: the migration gives it one, and the backfill queues it then
	}
	version := rec.Version
	if version < 1 {
		version = 1
	}
	base := fmt.Sprintf("/v1/%s/%s/v%d-%s", doc[:3], doc, version, digest[:8])
	for _, r := range []store.DropboxOutboxRow{
		{Kind: store.DropboxKindVersion, Digest: digest, DocID: doc, Version: version, Path: base + "." + dropboxExtOf(rec.MediaType), ArtifactAt: rec.CreatedAt},
		{Kind: store.DropboxKindItemData, Digest: digest, DocID: doc, Version: version, Path: base + ".item_data.json", ArtifactAt: rec.CreatedAt},
	} {
		if _, err := b.outbox.Enqueue(ctx, r); err != nil {
			return err
		}
	}
	return nil
}

// Backfill queues every upload record that has no outbox row yet (the queue is idempotent by path).
func (b *DropboxBackup) Backfill(ctx context.Context) {
	forEachUploadRecord(b.coralDir, func(_, digest string, rec agentUploadRecord) bool {
		_ = b.enqueue(ctx, digest, rec)
		return ctx.Err() == nil
	})
}

// ready is the condition every send depends on, checked when a pass starts and again before each batch commit (Security's change a).
func (b *DropboxBackup) ready(ctx context.Context) bool {
	if b.d == nil || b.d.appKey() == "" {
		return false
	}
	c, err := b.d.store.Get(ctx)
	if err != nil || !c.Connected || c.State == store.DropboxStateReconnect || c.State == store.DropboxStateQuotaFull {
		return false
	}
	return !b.d.looksLikeCopy(ctx)
}

// record finds the upload record of digest that is the document doc.
func (b *DropboxBackup) record(digest, doc string) (seriesRecord, int, bool) {
	var found seriesRecord
	ok := false
	count := 0
	for _, r := range recordsOfDigest(b.coralDir, digest) {
		if docIDOf(r.rec) == doc {
			count++
			if !ok {
				found, ok = r, true
			}
		}
	}
	return found, count, ok
}

// readObject reads artifacts/objects/<digest> without following a link, as a regular file, capped, and checks its SHA-256 equals the digest.
func (b *DropboxBackup) readObject(digest string) ([]byte, error) {
	f, err := os.OpenFile(filepath.Join(b.coralDir, "artifacts", "objects", digest), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return nil, os.ErrNotExist
	}
	data, err := io.ReadAll(io.LimitReader(f, dropboxObjectMax+1))
	if err != nil {
		return nil, err
	}
	if len(data) > dropboxObjectMax {
		return nil, errors.New("too big")
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != digest {
		return nil, errors.New("not the digest")
	}
	return data, nil
}

// cleanValue keeps a value on one line, without control or bidi characters, capped at dropboxValueMax bytes (Security's change d).
func cleanValue(s string) string {
	var sb strings.Builder
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if sb.Len()+len(string(r)) > dropboxValueMax {
			break
		}
		sb.WriteRune(r)
	}
	return sb.String()
}

// itemData is the sidecar: a closed field list, each value capped, never hub_user.
func (b *DropboxBackup) itemData(ctx context.Context, digest string, r seriesRecord, uploads int) []byte {
	server, _ := b.d.store.ServerID(ctx)
	m := map[string]any{
		"name":         cleanValue(r.rec.Name),
		"server_id":    server,
		"agent":        cleanValue(r.rec.Uploader),
		"session":      cleanValue(r.session),
		"board":        cleanValue(r.rec.Board),
		"uploaded_at":  cleanValue(r.rec.CreatedAt),
		"upload_count": uploads,
		"digest":       digest,
	}
	if r.rec.TaskID > 0 {
		m["task_id"] = r.rec.TaskID
	}
	out, _ := json.Marshal(m)
	if len(out) > dropboxItemDataMax {
		delete(m, "name")
		out, _ = json.Marshal(m)
	}
	return out
}

type dropboxSend struct {
	row  store.DropboxOutboxRow
	data []byte
	hash string
	sess string
}

// Pass sends what is due, once. It returns quietly whenever a condition does not hold.
func (b *DropboxBackup) Pass(ctx context.Context) {
	b.passMu.Lock()
	defer b.passMu.Unlock()
	if !b.ready(ctx) {
		return
	}
	if battery, metered := b.power(); battery || metered {
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
		slog.Info("[dropbox] the backup paused: Dropbox no longer accepts the sign-in")
		return
	}
	if err != nil {
		return
	}
	if used, alloc, err := cl.SpaceUsage(ctx, access); err != nil || (alloc > 0 && used*10 >= alloc*9) {
		return // stop at 90% of the space (design v33 §8), or retry when the space cannot be read
	}
	now := b.now()
	rows, err := b.outbox.Next(ctx, now, dropboxBatchRows)
	if err != nil || len(rows) == 0 {
		return
	}
	digests := map[string]bool{}
	for _, r := range rows {
		digests[r.Digest] = true
	}
	ids := make([]string, 0, len(digests))
	for d := range digests {
		ids = append(ids, d)
	}
	private, err := b.private(ctx, ids)
	if err != nil {
		return // an unreadable mark sends nothing (fail closed)
	}
	var types map[string]bool
	if b.types != nil {
		types = b.types()
	}
	var maxAge time.Duration
	if b.maxAge != nil {
		maxAge = b.maxAge()
	}
	var batch []dropboxSend
	inFlight := 0
	flush := func() bool {
		ok := b.send(ctx, cl, access, batch)
		batch, inFlight = nil, 0
		return ok
	}
	for _, row := range rows {
		if private[row.Digest] {
			_ = b.outbox.MarkRetry(ctx, row.ID, now.Add(time.Hour))
			continue
		}
		r, uploads, found := b.record(row.Digest, row.DocID)
		if !found {
			_ = b.outbox.MarkParked(ctx, row.ID, store.DropboxOutboxSkipped)
			continue
		}
		ext := dropboxExtOf(r.rec.MediaType)
		at, _ := time.Parse(time.RFC3339, row.ArtifactAt)
		if (len(types) > 0 && !types[ext]) || (maxAge > 0 && !at.IsZero() && now.Sub(at) > maxAge) {
			_ = b.outbox.MarkRetry(ctx, row.ID, now.Add(24*time.Hour)) // not chosen now: never deleted, looked at again later
			continue
		}
		var data []byte
		if row.Kind == store.DropboxKindItemData {
			// The sidecar goes only while its artifact's bytes are here: an artifact gone since it was queued sends nothing at all.
			if st, err := os.Lstat(filepath.Join(b.coralDir, "artifacts", "objects", row.Digest)); err != nil || !st.Mode().IsRegular() {
				_ = b.outbox.MarkParked(ctx, row.ID, store.DropboxOutboxSkipped)
				continue
			}
			data = b.itemData(ctx, row.Digest, r, uploads)
		} else {
			data, err = b.readObject(row.Digest)
			if errors.Is(err, os.ErrNotExist) {
				_ = b.outbox.MarkParked(ctx, row.ID, store.DropboxOutboxSkipped)
				continue
			}
			if err != nil {
				_ = b.outbox.MarkParked(ctx, row.ID, store.DropboxOutboxFailed)
				continue
			}
			if dropboxTextExt[ext] && b.secret(data) {
				_ = b.outbox.MarkSecret(ctx, row.ID)
			}
		}
		if inFlight+len(data) > dropboxInFlight && len(batch) > 0 {
			if !flush() {
				return
			}
		}
		batch = append(batch, dropboxSend{row: row, data: data, hash: dropbox.ContentHash(data)})
		inFlight += len(data)
	}
	if len(batch) > 0 {
		flush()
	}
}

// send uploads a batch through parallel sessions, checks readiness again, commits, and records each outcome. It reports whether the pass may go on.
func (b *DropboxBackup) send(ctx context.Context, cl *dropbox.Client, access string, batch []dropboxSend) bool {
	sem := make(chan struct{}, b.parallel)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var limited *dropbox.RateLimited
	for i := range batch {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			id, err := cl.StartSession(ctx, access, batch[i].data)
			mu.Lock()
			defer mu.Unlock()
			var rl *dropbox.RateLimited
			if errors.As(err, &rl) {
				limited = rl
			}
			batch[i].sess = id
		}(i)
	}
	wg.Wait()
	now := b.now()
	if limited != nil {
		for _, s := range batch {
			_ = b.outbox.MarkRetry(ctx, s.row.ID, now.Add(limited.After))
		}
		if b.parallel > 1 {
			b.parallel /= 2 // honour Retry-After and halve the parallelism
		}
		return false
	}
	if !b.ready(ctx) {
		return false // a take over, a reconnect or a copy happened mid-pass: nothing is committed (Security's change a)
	}
	var commits []dropbox.Commit
	var sent []dropboxSend
	for _, s := range batch {
		if s.sess == "" {
			_ = b.outbox.MarkRetry(ctx, s.row.ID, now.Add(backoff(s.row.Attempts)))
			continue
		}
		commits = append(commits, dropbox.Commit{SessionID: s.sess, Size: int64(len(s.data)), Path: s.row.Path})
		sent = append(sent, s)
	}
	if len(commits) == 0 {
		return true
	}
	res, err := cl.FinishBatch(ctx, access, commits)
	if err != nil {
		for _, s := range sent {
			_ = b.outbox.MarkRetry(ctx, s.row.ID, now.Add(backoff(s.row.Attempts)))
		}
		return false
	}
	goOn := true
	done := 0
	for i, r := range res {
		s := sent[i]
		switch r.Outcome {
		case dropbox.CommitOK:
			if r.ContentHash != s.hash {
				_ = b.outbox.MarkParked(ctx, s.row.ID, store.DropboxOutboxFailed)
				continue
			}
			_ = b.outbox.MarkDone(ctx, s.row.ID, r.FileID, r.Rev, r.ContentHash)
			done++
		case dropbox.CommitConflict:
			// One metadata check: the same bytes already there are done; anything else is parked, never overwritten and never retried in a loop.
			m, err := cl.Metadata(ctx, access, s.row.Path)
			if err == nil && m.ContentHash == s.hash {
				_ = b.outbox.MarkDone(ctx, s.row.ID, m.FileID, m.Rev, m.ContentHash)
				done++
			} else {
				_ = b.outbox.MarkParked(ctx, s.row.ID, store.DropboxOutboxConflict)
			}
		case dropbox.CommitNoSpace:
			_ = b.d.store.SetState(ctx, store.DropboxStateQuotaFull)
			_ = b.outbox.MarkRetry(ctx, s.row.ID, now.Add(time.Hour))
			goOn = false
		case dropbox.CommitTooManyWrites:
			_ = b.outbox.MarkRetry(ctx, s.row.ID, now.Add(backoff(s.row.Attempts)))
			if b.parallel > 1 {
				b.parallel /= 2
			}
		default:
			_ = b.outbox.MarkRetry(ctx, s.row.ID, now.Add(backoff(s.row.Attempts)))
		}
	}
	if done > 0 {
		slog.Info("[dropbox] backed up", "files", done)
	}
	return goOn
}

// backoff is the wait before a retry: doubling from a minute, capped at an hour.
func backoff(attempts int) time.Duration {
	d := time.Minute
	for i := 0; i < attempts && d < time.Hour; i++ {
		d *= 2
	}
	if d > time.Hour {
		d = time.Hour
	}
	return d
}

// osPower says whether this computer runs on battery or a metered network, where the system reports it (design v33 §8). A metered network is not
// reported on any system Coral reads yet, so it is always false.
func osPower() (onBattery, metered bool) {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("/usr/bin/pmset", "-g", "batt").Output()
		return err == nil && bytes.Contains(out, []byte("'Battery Power'")), false
	case "linux":
		ac, _ := filepath.Glob("/sys/class/power_supply/A*/online")
		for _, p := range ac {
			if b, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(b)) == "1" {
				return false, false
			}
		}
		bats, _ := filepath.Glob("/sys/class/power_supply/BAT*/status")
		for _, p := range bats {
			if b, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(b)) == "Discharging" {
				return true, false
			}
		}
	}
	return false, false
}
