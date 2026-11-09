package routes

// Dropbox stage 6b, piece 2 (#14845; the 6b delta v2 and Security Reviewer's conditions 1 to 10, 3a and 3b): the offload pass. Once an hour, when
// the Operator turned Free up space on, it frees the local bytes of old artifacts whose copy Dropbox holds, one object at a time, each step only
// after the one before succeeded:
//  1. a sample round trip (a random 1 KiB probe under /v1/probe/<server id>/, uploaded, read back by its rev, deleted at its rev; a probe a crash
//     left is deleted first); any failure frees nothing;
//  2. the candidates from the store (piece 1), less any the board marks private (fail closed: an unreadable mark frees nothing) and any a running
//     task or an open session references (the prune's own scan; unreadable frees nothing);
//  3. per object, under its digest lock: the local file is regular and its SHA-256 is the digest; Dropbox's content hash of these bytes equals the
//     ledger's and the file's fresh metadata (rev and content hash) at the ledger path; this Coral's marker v1/offloaded/<hhh>/<digest>/<server id>
//     is written and read back; the offload row is committed; only then the bytes go (the sidecar and every record stay);
//  4. at most 200 objects and 2 GiB a pass. A crash between steps leaves the bytes in place.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/secfile"
	"github.com/subgentic/coral/internal/store"
)

const (
	offloadPerPass      = 200
	offloadBytesPerPass = 2 << 30
	offloadEvery        = time.Hour
)

var errOffloadProbe = errors.New("the Dropbox round trip failed")

// SetReferences gives the worker the prune's reference scan (the digests a running task or an open session names). Without it nothing is freed.
func (b *DropboxBackup) SetReferences(f func(ctx context.Context) (map[string]bool, error)) {
	if f != nil {
		b.references = f
	}
}

// offloadMarker is this Coral's marker for digest: an empty file that says this Coral keeps the object only in Dropbox.
func offloadMarker(digest, serverID string) string {
	return "/v1/offloaded/" + digest[:3] + "/" + digest + "/" + serverID
}

// uploadOne stores data at path in add mode (never over a file already there) and answers what Dropbox stored.
func uploadOne(ctx context.Context, cl *dropbox.Client, access, path string, data []byte) (dropbox.CommitResult, error) {
	sid, err := cl.StartSession(ctx, access, data)
	if err != nil {
		return dropbox.CommitResult{}, err
	}
	res, err := cl.FinishBatch(ctx, access, []dropbox.Commit{{SessionID: sid, Size: int64(len(data)), Path: path}})
	if err != nil || len(res) != 1 {
		return dropbox.CommitResult{}, errors.Join(err, errOffloadProbe)
	}
	return res[0], nil
}

// probe is the sample round trip: a probe a crash left is deleted first, then a new one is uploaded, downloaded by its rev and compared, and
// deleted at its rev. Any failure is an error and frees nothing.
func (b *DropboxBackup) probe(ctx context.Context, cl *dropbox.Client, access, serverID string) error {
	folder := "/v1/probe/" + serverID
	if names, err := cl.ListNames(ctx, access, folder); err == nil {
		for _, n := range names {
			m, merr := cl.Metadata(ctx, access, folder+"/"+n)
			if merr != nil {
				return merr
			}
			if _, _, derr := b.runDelete(ctx, cl, access, []dropbox.Delete{{Path: folder + "/" + n, Rev: m.Rev}}); derr != nil {
				return derr
			}
		}
	} else if !errors.Is(err, dropbox.ErrNotFound) {
		return err
	}
	data := make([]byte, 1024)
	if _, err := rand.Read(data); err != nil {
		return err
	}
	name := make([]byte, 8)
	_, _ = rand.Read(name)
	path := folder + "/" + hex.EncodeToString(name)
	res, err := uploadOne(ctx, cl, access, path, data)
	if err != nil || res.Outcome != dropbox.CommitOK || res.ContentHash != dropbox.ContentHash(data) {
		return errors.Join(err, errOffloadProbe)
	}
	h := sha256.New()
	if _, _, err := cl.Download(ctx, access, res.Rev, int64(len(data)), h); err != nil {
		return err
	}
	want := sha256.Sum256(data)
	if hex.EncodeToString(h.Sum(nil)) != hex.EncodeToString(want[:]) {
		return errOffloadProbe
	}
	outs, done, err := b.runDelete(ctx, cl, access, []dropbox.Delete{{Path: path, Rev: res.Rev}})
	if err != nil || !done || len(outs) != 1 || outs[0] != dropbox.DeleteOK {
		return errors.Join(err, errOffloadProbe)
	}
	return nil
}

// Offload is the pass (at most once an hour, only when the Operator turned Free up space on). It reports how many objects and bytes it freed.
func (b *DropboxBackup) Offload(ctx context.Context) (int, int64) {
	days, last, err := b.d.store.Offload(ctx)
	if err != nil || days <= 0 || !b.ready(ctx) {
		return 0, 0
	}
	now := time.Now()
	if t, perr := time.Parse(time.RFC3339, last); perr == nil && (now.Before(t) || now.Sub(t) < offloadEvery) {
		return 0, 0 // at most once an hour, and never when the clock is behind the last pass
	}
	if onBattery, metered := b.power(); onBattery || metered {
		return 0, 0
	}
	_ = b.d.store.SetOffloadPass(ctx, now.UTC().Format(time.RFC3339))
	refuse := func(word string) (int, int64) {
		_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditOffloadPass, Reason: word})
		return 0, 0
	}
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		return refuse("not_connected")
	}
	serverID, err := b.d.store.ServerID(ctx)
	if err != nil || serverID == "" {
		return refuse("no_server_id")
	}
	if err := b.probe(ctx, cl, access, serverID); err != nil {
		return refuse("probe_failed")
	}
	cands, err := b.outbox.OffloadCandidates(ctx, account, now.Add(-time.Duration(days)*24*time.Hour), now.Add(-store.DropboxOffloadOpenedFor), offloadPerPass)
	if err != nil || len(cands) == 0 {
		return 0, 0
	}
	ids := make([]string, len(cands))
	for i, c := range cands {
		ids[i] = c.Digest
	}
	private, err := b.private(ctx, ids)
	if err != nil {
		return refuse("private_unreadable") // fail closed (Security's 3a)
	}
	refs, err := b.references(ctx)
	if err != nil {
		return refuse("references_unreadable") // fail closed (Security's 3b)
	}
	n, freed := 0, int64(0)
	for _, c := range cands {
		if ctx.Err() != nil || freed+c.Size > offloadBytesPerPass {
			break
		}
		if private[c.Digest] || refs[c.Digest] {
			continue
		}
		size, ok := b.offloadOne(ctx, cl, access, account, serverID, c)
		if ok {
			n++
			freed += size
		}
	}
	_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditOffloadPass, Count: n, Bytes: freed})
	if n > 0 {
		noteArtifactsChanged()
	}
	slog.Info("[dropbox] offload pass", "freed", n, "bytes", freed)
	return n, freed
}

// offloadOne frees one object, under its digest lock, only after every check (see the file's comment). It never removes a byte when a step fails.
func (b *DropboxBackup) offloadOne(ctx context.Context, cl *dropbox.Client, access, account, serverID string, c store.OffloadCandidate) (int64, bool) {
	if !objectNameRe.MatchString(c.Digest) {
		return 0, false
	}
	defer lockArtifact(c.Digest)()
	obj := filepath.Join(b.coralDir, "artifacts", "objects", c.Digest)
	f, err := secfile.OpenNoFollow(obj, os.O_RDONLY, 0)
	if err != nil {
		return 0, false
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		_ = f.Close()
		return 0, false
	}
	data, err := io.ReadAll(io.LimitReader(f, maxAgentArtifactSize+1))
	_ = f.Close()
	if err != nil || int64(len(data)) != st.Size() {
		return 0, false
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != c.Digest {
		return 0, false // not its digest: never freed
	}
	local := dropbox.ContentHash(data)
	m, err := cl.Metadata(ctx, access, c.Path)
	if err != nil || m.Rev != c.Rev || m.ContentHash != c.ContentHash || local != c.ContentHash {
		return 0, false // Dropbox does not hold these exact bytes at the ledger's place today (Security's condition 3)
	}
	marker := offloadMarker(c.Digest, serverID)
	res, err := uploadOne(ctx, cl, access, marker, nil)
	if err != nil || (res.Outcome != dropbox.CommitOK && res.Outcome != dropbox.CommitConflict) {
		return 0, false
	}
	if _, err := cl.Metadata(ctx, access, marker); err != nil {
		return 0, false // not read back: nothing goes
	}
	if err := b.outbox.RecordOffloaded(ctx, store.DropboxOffloaded{Digest: c.Digest, AccountID: account, Path: c.Path, Rev: c.Rev, ContentHash: c.ContentHash, Size: st.Size()}); err != nil {
		return 0, false
	}
	if err := os.Remove(obj); err != nil {
		_ = b.outbox.ForgetOffloaded(context.WithoutCancel(ctx), c.Digest) // the bytes are still here: no row says otherwise
		return 0, false
	}
	storeFor(b.coralDir).removed(st.Size())
	return st.Size(), true
}

var (
	errKeptInDropbox = errors.New("this file is kept only in Dropbox and could not be fetched right now")
	errOtherAccount  = errors.New("the Dropbox account connected now is not the one that keeps this file")
)

// fetchBackLocked brings an offloaded object's bytes back (Security's 3a), the caller holding the digest lock: by the ledger path's stored rev
// (Dropbox keeps a file's earlier revisions, so an edit made there since is never served under this digest), capped by the recorded size, into an
// exclusive 0600 temp file in the objects folder, SHA-256 equal to the digest, fits() checked, then renamed into place. Only then this Coral's marker
// is deleted (read back as gone) and the offload row forgotten, and the fetch is recorded as an open. Nothing changes on any failure. It answers
// true when the bytes are here (fetched now, or never freed).
func (b *DropboxBackup) fetchBackLocked(ctx context.Context, digest string) (bool, error) {
	row, ok, err := b.outbox.Offloaded(ctx, digest)
	if err != nil {
		return false, err
	}
	obj := filepath.Join(b.coralDir, "artifacts", "objects", digest)
	if !ok {
		_, serr := os.Lstat(obj)
		return serr == nil, nil
	}
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		return false, errKeptInDropbox
	}
	if account != row.AccountID {
		return false, errOtherAccount
	}
	if !storeFor(b.coralDir).fits(row.Size) {
		return false, errStoreFull
	}
	tmp, err := os.CreateTemp(filepath.Dir(obj), artifactUploadTempP+"*")
	if err != nil {
		return false, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // a no-op once renamed
	h := sha256.New()
	_, n, derr := cl.Download(ctx, access, row.Rev, row.Size, io.MultiWriter(tmp, h))
	cerr := tmp.Close()
	if derr != nil || cerr != nil || n != row.Size || hex.EncodeToString(h.Sum(nil)) != digest {
		return false, errKeptInDropbox // never other bytes under this digest
	}
	if err := os.Rename(tmpPath, obj); err != nil {
		return false, err
	}
	storeFor(b.coralDir).added(row.Size)
	if serverID, err := b.d.store.ServerID(ctx); err == nil && serverID != "" {
		marker := offloadMarker(digest, serverID)
		if m, merr := cl.Metadata(ctx, access, marker); merr == nil {
			_, _, _ = b.runDelete(ctx, cl, access, []dropbox.Delete{{Path: marker, Rev: m.Rev}})
		}
		if _, merr := cl.Metadata(ctx, access, marker); merr == nil || !errors.Is(merr, dropbox.ErrNotFound) {
			// The bytes are here; the marker stays until a later fetch or pass removes it. Keeping the row would say the bytes are away, so it
			// goes: a stray marker of this Coral only keeps retention from deleting the Dropbox copy, which is the safe side.
			slog.Warn("[dropbox] a fetched-back file's marker could not be removed yet")
		}
	}
	_ = b.outbox.ForgetOffloaded(ctx, digest)
	_ = b.outbox.RecordOpened(ctx, digest, time.Now())
	return true, nil
}

// FetchBack is fetchBackLocked under the digest lock.
func (b *DropboxBackup) FetchBack(ctx context.Context, digest string) (bool, error) {
	if !objectNameRe.MatchString(digest) {
		return false, errors.New("not an artifact id")
	}
	defer lockArtifact(digest)()
	return b.fetchBackLocked(ctx, digest)
}

// forgetOwnMarkerLocked removes this Coral's marker of a digest (read back as gone) and its offload row, the caller holding the digest lock: for an
// artifact deleted here, whose Dropbox copy the Operator's removal then deletes. A marker that will not go keeps the row (fail closed).
func (b *DropboxBackup) forgetOwnMarkerLocked(ctx context.Context, cl *dropbox.Client, access, digest string) {
	serverID, err := b.d.store.ServerID(ctx)
	if err != nil || serverID == "" {
		return
	}
	marker := offloadMarker(digest, serverID)
	if m, merr := cl.Metadata(ctx, access, marker); merr == nil {
		_, _, _ = b.runDelete(ctx, cl, access, []dropbox.Delete{{Path: marker, Rev: m.Rev}})
	}
	if _, merr := cl.Metadata(ctx, access, marker); merr != nil && errors.Is(merr, dropbox.ErrNotFound) {
		_ = b.outbox.ForgetOffloaded(ctx, digest)
	}
}

// refuseWhileOffloaded answers 409 when this Coral keeps files only in Dropbox (or cannot tell): Disconnect (with or without deleting the backup),
// Switch, Take over and Rekey would leave them with no way back (Security's condition 5 and 3b on d766be37a). It reports whether it refused.
func (h *CloudHandler) refuseWhileOffloaded(w http.ResponseWriter, r *http.Request) bool {
	if h.dbx == nil || h.dbx.outbox == nil {
		return false
	}
	n, _, err := h.dbx.outbox.OffloadedTotals(r.Context())
	if err != nil {
		writeError(w, http.StatusConflict, "kept_in_dropbox", "Coral could not check whether files are kept only in Dropbox, so nothing was changed. Try again.")
		return true
	}
	if n > 0 {
		writeError(w, http.StatusConflict, "kept_in_dropbox", fmt.Sprintf("%d %s kept only in Dropbox. Bring them back first (turn off Free up space), then try again.", n, map[bool]string{true: "file is", false: "files are"}[n == 1]))
		return true
	}
	return false
}
