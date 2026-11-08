package routes

// Dropbox stage 5a (#14714; design v33 §6 and the 5a delta v2 with Security's MUSTs A to D and SHOULDs E to I): edits made in Dropbox. A listing
// pass reads /v1 with a stored cursor, a page at a time. Only version files in this Coral's ledger, of the account connected now, are looked at. An
// unchanged content hash is a touch (the new rev is recorded, nothing fetched); a changed one is fetched by exactly the listed rev, capped by what is
// read, into an exclusive 0600 temp file, named by the digest computed on arrival, typed by its bytes within the closed map, and held as the
// document's pending edit with NO upload record (invisible to every list, search, link, grant, agent and Hub route). Pending edits are bounded (200,
// 1 GiB; 20 fetches and 256 MiB a pass); beyond a bound nothing is fetched and the cursor stays, so the listing finds them again. A done version file
// deleted in Dropbox is queued again while the local copy is here. Retention keeps a document with an open edit (keepDoc, in this same commit:
// Security's condition). Logs carry counts only.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/secfile"
	"github.com/subgentic/coral/internal/store"
)

const (
	dropboxEditMaxSize   = 64 << 20  // one edit, at most (a declared size over it is refused before reading)
	dropboxEditFetches   = 20        // fetches a pass
	dropboxEditPassBytes = 256 << 20 // bytes fetched a pass
)

// editBounds are the limits of Security's MUST A (fields so a test can shrink them).
type editBounds struct {
	maxOpen, perPass        int
	maxOpenBytes, passBytes int64
}

var defaultEditBounds = editBounds{maxOpen: store.DropboxEditsMax, perPass: dropboxEditFetches, maxOpenBytes: store.DropboxEditsMaxBytes, passBytes: dropboxEditPassBytes}

// editPass is one listing pass's tally.
type editPass struct {
	fetched, held, touched, requeued, skipped, waiting int
	bytes                                              int64
	stop                                               bool // a bound was reached: nothing more is fetched, and the cursor is not moved on
}

// Notice runs one listing pass when the backup may talk to Dropbox: the same readiness as uploads (quota_full included: reading needs no space).
func (b *DropboxBackup) Notice(ctx context.Context) {
	if b.edits == nil {
		return
	}
	b.passMu.Lock()
	defer b.passMu.Unlock()
	// Whatever the readiness: the open edits of an account no longer connected go (a Disconnect, another account, a Rekey: Security's condition
	// c), then every held file no open edit names.
	keep := ""
	if c, err := b.d.store.Get(ctx); err == nil && c.Connected {
		keep = c.AccountID
	}
	_, _ = b.edits.DropOtherAccounts(ctx, keep)
	b.sweepHeld(ctx)
	if b.d == nil || b.d.appKey() == "" || b.d.looksLikeCopy(ctx) {
		return
	}
	c, err := b.d.store.Get(ctx)
	if err != nil || !c.Connected || c.AccountID == "" || c.State == store.DropboxStateReconnect {
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
		return
	}
	if err != nil {
		return
	}
	cursor, err := b.d.store.ListCursor(ctx)
	if err != nil {
		return
	}
	var p editPass
	var page dropbox.ListPage
	for pages := 0; pages < 1000 && ctx.Err() == nil; pages++ {
		if cursor == "" {
			page, err = cl.ListFolder(ctx, access, "/v1")
		} else {
			page, err = cl.ListFolderContinue(ctx, access, cursor)
		}
		if errors.Is(err, dropbox.ErrCursorReset) {
			cursor = "" // start again: known revs are not fetched again (an equal hash or the same pending rev)
			_ = b.d.store.SetListCursor(ctx, c.AccountID, "")
			continue
		}
		if err != nil {
			break // a missing /v1 (nothing backed up yet), a rate limit or Dropbox's trouble: the next pass tries again
		}
		for _, e := range page.Entries {
			b.noticeEntry(ctx, cl, access, c.AccountID, e, &p)
		}
		if p.stop {
			break // the rest of this page waits: the cursor is not moved past what was not looked at
		}
		cursor = page.Cursor
		_ = b.d.store.SetListCursor(ctx, c.AccountID, cursor)
		if !page.HasMore {
			break
		}
	}
	b.editsWaiting.Store(int64(p.waiting))
	if p.fetched+p.touched+p.requeued+p.skipped+p.waiting > 0 {
		slog.Info("[dropbox] listing pass", "files", p.held, "bytes", p.bytes)
	}
}

// noticeEntry looks at one listed entry.
func (b *DropboxBackup) noticeEntry(ctx context.Context, cl *dropbox.Client, access, account string, e dropbox.ListEntry, p *editPass) {
	row, err := b.outbox.ByPath(ctx, e.PathLower)
	if err != nil || row.AccountID != account || row.Kind != store.DropboxKindVersion || !strings.HasPrefix(row.Path, "/v1/") {
		return // not this Coral's version file in this account (a sidecar, another account's file, anything else): never read back
	}
	switch e.Tag {
	case "deleted":
		if row.State == store.DropboxOutboxDoneS {
			if ok, _ := b.outbox.Requeue(ctx, row.ID); ok {
				p.requeued++
			}
		}
		return
	case "file":
	default:
		return
	}
	if row.State != store.DropboxOutboxDoneS && row.State != store.DropboxOutboxEdited {
		return
	}
	if e.Rev == "" || e.Rev == row.Rev {
		return
	}
	if row.ContentHash != "" && e.ContentHash == row.ContentHash {
		_ = b.outbox.SeeRev(ctx, row.ID, e.Rev) // a touch: the same bytes; nothing is fetched (Security's MUST B)
		p.touched++
		return
	}
	if seen, err := b.edits.SeenRev(ctx, row.DocID, e.Rev); err != nil || seen {
		return // already held (or decided): never fetched twice
	}
	if e.Size > dropboxEditMaxSize || e.Size < 0 {
		p.skipped++
		return
	}
	bounds := b.editBounds
	n, held, err := b.edits.Stats(ctx)
	if p.stop || err != nil || n >= bounds.maxOpen || held+e.Size > bounds.maxOpenBytes || p.fetched >= bounds.perPass || p.bytes+e.Size > bounds.passBytes || !storeFor(b.coralDir).fits(e.Size) {
		p.waiting++
		p.stop = true
		return
	}
	p.fetched++
	digest, size, mt, err := b.fetchEdit(ctx, cl, access, e, row)
	if errors.Is(err, dropbox.ErrTooBig) || errors.Is(err, errNotTheListedFile) || errors.Is(err, errNoOriginal) {
		p.skipped++ // this file will not do as listed: looked at again only when it changes
		return
	}
	if err != nil {
		// A passing trouble (the network, a rate limit, a full store, a failed write): like a bound, the pass stops here and the cursor stays, so
		// the edit is looked at again next pass, never missed (Security's SHOULD 7 on 085c4511b).
		p.waiting++
		p.stop = true
		return
	}
	p.bytes += size
	if digest == row.Digest {
		_ = b.outbox.SeeRev(ctx, row.ID, e.Rev) // the same bytes as Coral's own (a revert): nothing pending
		b.dropHeld(ctx, digest)
		p.touched++
		return
	}
	prev, _ := b.edits.Get(ctx, row.DocID)
	if err := b.edits.Hold(ctx, store.DropboxEdit{AccountID: account, DocID: row.DocID, Version: row.Version, OrigDigest: row.Digest, Path: row.Path,
		Digest: digest, MediaType: mt, Size: size, Rev: e.Rev}); err == nil {
		p.held++
		if prev.Digest != "" && prev.Digest != digest {
			b.dropHeld(ctx, prev.Digest) // the older edit of this document is replaced: its bytes go
		}
	} else {
		b.dropHeld(ctx, digest) // not held (a decision is being written): the fetched bytes go
	}
}

// fetchEdit downloads exactly the listed rev into an exclusive 0600 temp file in the store's own folder, capped by what is read (Security's MUST C),
// checks the rev and size against the listing (MUST B), types it by its bytes (MUST D), and stores it as an object with no upload record.
func (b *DropboxBackup) fetchEdit(ctx context.Context, cl *dropbox.Client, access string, e dropbox.ListEntry, row store.PathRow) (string, int64, string, error) {
	dir := b.heldDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", 0, "", err
	}
	tmp, err := os.CreateTemp(dir, artifactUploadTempP+"*") // O_EXCL, 0600
	if err != nil {
		return "", 0, "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // gone on every failure; renamed away on success
	h := sha256.New()
	head := &headWriter{max: 512}
	got, n, err := cl.Download(ctx, access, e.Rev, dropboxEditMaxSize, io.MultiWriter(tmp, h, head))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", 0, "", err
	}
	if got.Rev != e.Rev || n != e.Size || got.Size != e.Size {
		return "", 0, "", errNotTheListedFile
	}
	digest := hex.EncodeToString(h.Sum(nil))
	orig, _, ok := b.record(row.Digest, row.DocID)
	if !ok {
		return "", 0, "", errNoOriginal
	}
	mt := typeByBytes(orig.rec.MediaType, head.buf)
	// Held OUTSIDE the artifact store (the 5a fix after Security's SHOULD 8 test): no artifact route reads this folder and no list scans it, so
	// nothing, an agent with the digest or the Operator's own list, sees the bytes before the decision moves them into the store.
	final := b.heldPath(digest)
	if _, err := os.Lstat(final); err == nil {
		return digest, n, mt, nil // the same bytes are held already
	}
	if err := os.Rename(tmpPath, final); err != nil {
		return "", 0, "", err
	}
	return digest, n, mt, nil
}

// heldDir is where held edits wait: artifacts/dropbox-held, beside the store and never part of it.
func (b *DropboxBackup) heldDir() string {
	return filepath.Join(b.coralDir, "artifacts", "dropbox-held")
}

// heldPath is a held edit's file, named by its digest (64 hex, from the hash computed on arrival).
func (b *DropboxBackup) heldPath(digest string) string { return filepath.Join(b.heldDir(), digest) }

var heldNameRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// dropHeld removes a held file no open edit names any more (a newer edit replaced it, or it was decided): only an exact 64-hex name that is a
// regular file (never a link or a folder someone put there).
func (b *DropboxBackup) dropHeld(ctx context.Context, digest string) {
	if !heldNameRe.MatchString(digest) {
		return
	}
	if held, err := b.edits.Holds(ctx, digest); err != nil || held {
		return
	}
	if st, err := os.Lstat(b.heldPath(digest)); err == nil && st.Mode().IsRegular() {
		_ = os.Remove(b.heldPath(digest))
	}
}

// openHeld opens a held file for a decision without following a link, as a regular file, and checks its bytes still hash to the digest and its
// size (Security's conditions a and b on #14714): a file changed on disk is not stored; the edit goes back to pending.
func (b *DropboxBackup) openHeld(e store.DropboxEdit) error {
	f, err := secfile.OpenNoFollow(b.heldPath(e.Digest), os.O_RDONLY, 0)
	if err != nil {
		return errHeldChanged
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() != e.Size {
		return errHeldChanged
	}
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, dropboxEditMaxSize+1)); err != nil || hex.EncodeToString(h.Sum(nil)) != e.Digest {
		return errHeldChanged
	}
	return nil
}

var errHeldChanged = errors.New("the held edit changed on disk")

// sweepHeld removes what no open edit names: a temp file left over an hour by a stopped fetch, or a held file whose edit was decided or replaced.
func (b *DropboxBackup) sweepHeld(ctx context.Context) {
	ents, err := os.ReadDir(b.heldDir())
	if err != nil {
		return
	}
	for _, de := range ents {
		name := de.Name()
		if strings.HasPrefix(name, artifactUploadTempP) {
			if info, err := de.Info(); err == nil && info.Mode().IsRegular() && time.Since(info.ModTime()) > time.Hour {
				_ = os.Remove(filepath.Join(b.heldDir(), name))
			}
			continue
		}
		b.dropHeld(ctx, name) // only an exact 64-hex regular file
	}
}

var (
	errNotTheListedFile = errors.New("the download is not the listed file")
	errNoOriginal       = errors.New("no record of the original")
)

// headWriter keeps the first max bytes written through it.
type headWriter struct {
	buf []byte
	max int
}

func (w *headWriter) Write(p []byte) (int, error) {
	if room := w.max - len(w.buf); room > 0 {
		w.buf = append(w.buf, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

// typeByBytes is an edit's media type, from its bytes only (Security's MUST D): the original's type when the bytes are that kind of file, else
// application/octet-stream (uploaded and shown as .bin). Never from the Dropbox path, its extension or a name.
func typeByBytes(origType string, head []byte) string {
	const bin = "application/octet-stream"
	switch ext := dropboxExtOf(origType); ext {
	case "md", "txt", "csv", "json":
		if utf8.Valid(trimPartialRune(head)) && !bytes.ContainsRune(head, 0) && sniffImageFamily(head) == "" {
			return origType
		}
	case "png", "jpg", "gif", "webp":
		if fam := sniffImageFamily(head); fam != "" && dropboxExtOf(fam) == ext {
			return origType
		}
	case "pdf":
		if bytes.HasPrefix(head, []byte("%PDF-")) {
			return origType
		}
	case "mp4":
		if len(head) >= 12 && string(head[4:8]) == "ftyp" {
			return origType
		}
	}
	return bin
}

// trimPartialRune drops a rune cut at the end of a head, so a valid UTF-8 text cut at 512 bytes stays valid.
func trimPartialRune(b []byte) []byte {
	for i := 0; i < utf8.UTFMax && len(b) > 0; i++ {
		if utf8.Valid(b) {
			return b
		}
		b = b[:len(b)-1]
	}
	return b
}

// editsWaitingNow is the count of edits a pass left in Dropbox because of a bound (for the status).
func (b *DropboxBackup) editsWaitingNow() int { return int(b.editsWaiting.Load()) }
