package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/fsreplace"
	"github.com/subgentic/coral/internal/sshprov"
)

// Where the release package comes from for a set up or an upgrade (#15691): the far computer downloads it (the default), this hub downloads it and sends it over the SSH session, or the person uploads
// it in the browser. An upload is the person's act (never a script's), belongs to one plan, is held in a 0700 folder of this hub's own data folder, is capped, is removed when the run ends, the plan is
// cancelled or expires, and is installed only when its SHA-256 is the signed one for this hub's own tag (sshprov.Installer checks that, and the far side checks it again).

// Caps on what a person may upload: the package as the installer allows, and the two small signed files.
const (
	uploadMaxPackage = 300 << 20
	uploadMaxSums    = 64 << 10
	uploadMaxBundle  = 256 << 10
)

// provisionUploads is the part of a plan that holds uploaded files.
type provisionUploads struct {
	dir   string                  // the plan's 0700 folder, "" until the first upload
	files map[string]uploadedFile // by kind: "package", "sums", "bundle"
	// closed is set when the plan's files were removed (the run ended, the plan was cancelled or expired): a later upload is refused cleanly, never written to the emptied table (#15699, Security's SHOULD)
	closed bool
}

var errUploadsClosed = errors.New("the plan's uploads are closed")

type uploadedFile struct {
	path   string
	bytes  int64
	sha256 string
}

// SetUploadDir says where uploaded packages are held (under this hub's data folder); a folder left by an earlier run is emptied now. Without it, uploads are refused.
func (pr *Provisioner) SetUploadDir(dir string) {
	pr.mu.Lock()
	pr.uploadRoot = dir
	pr.mu.Unlock()
	if dir != "" {
		_ = os.RemoveAll(dir) // nothing in it can still belong to a plan: the plans are in memory
	}
}

// uploadKinds maps the page's kind to the cap.
var uploadKinds = map[string]int64{"package": uploadMaxPackage, "sums": uploadMaxSums, "bundle": uploadMaxBundle}

// Upload handles POST /api/servers/provision/{plan}/upload?kind=package|sums|bundle: the raw file as the body. Only a person at the dashboard, only for a set up or an upgrade, only before it runs.
// The answer carries the size and SHA-256 of what arrived, so the page can show them; never the path.
func (pr *Provisioner) Upload(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) {
		provisionPersonOnly(w)
		return
	}
	p := pr.plan(chi.URLParam(r, "plan"))
	if p == nil {
		errNotFound(w, "no such setup")
		return
	}
	kind := r.URL.Query().Get("kind")
	max, ok := uploadKinds[kind]
	if !ok {
		errBadRequest(w, "the kind is package, sums or bundle")
		return
	}
	if k := p.kind(); k != kindSetup && k != kindUpgrade {
		errBadRequest(w, "only a set up or an upgrade takes a package")
		return
	}
	p.mu.Lock()
	phase := p.phase
	p.mu.Unlock()
	switch phase {
	case phaseRunning, phaseTrusting, phaseDone, phaseFailed:
		errConflict(w, "this setup has already started")
		return
	}
	pr.mu.Lock()
	root := pr.uploadRoot
	pr.mu.Unlock()
	if root == "" {
		errConflict(w, "this hub cannot hold an uploaded package")
		return
	}
	if r.ContentLength > max {
		writeError(w, http.StatusRequestEntityTooLarge, "upload_too_large", "That file is larger than a release file can be")
		return
	}
	dir, err := p.uploadDirLocked(root)
	if errors.Is(err, errUploadsClosed) {
		errConflict(w, "this setup was cancelled or has expired")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not hold the uploaded file")
		return
	}
	tmp, err := os.CreateTemp(dir, "up-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not hold the uploaded file")
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // a refused or failed upload leaves nothing; a kept one was renamed away
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), http.MaxBytesReader(w, r.Body, max))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "upload_too_large", "That file is larger than a release file can be")
			return
		}
		errBadRequest(w, "the upload did not arrive")
		return
	}
	if n == 0 {
		errBadRequest(w, "that file is empty")
		return
	}
	final := filepath.Join(dir, kind)
	if pr.beforeUploadCommit != nil { // test seam: lets a test land a cancel or an expiry exactly here
		pr.beforeUploadCommit(p)
	}
	p.mu.Lock()
	if p.uploads.closed || p.uploads.dir != dir || p.uploads.files == nil { // the plan's files were removed while this one arrived: refuse; the temporary file is removed by the defer above
		p.mu.Unlock()
		errConflict(w, "this setup was cancelled or has expired")
		return
	}
	if p.phase == phaseRunning || p.phase == phaseTrusting || p.phase == phaseDone || p.phase == phaseFailed { // it started while the file arrived
		p.mu.Unlock()
		errConflict(w, "this setup has already started")
		return
	}
	if err := fsreplace.Rename(tmpName, final); err != nil { // a reader holding the destination fails os.Rename on Windows (#9738)
		p.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "", "could not hold the uploaded file")
		return
	}
	sum := hex.EncodeToString(h.Sum(nil))
	p.uploads.files[kind] = uploadedFile{path: final, bytes: n, sha256: sum}
	p.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"kind": kind, "bytes": n, "sha256": sum})
}

// uploadDirLocked makes the plan's 0700 folder on the first upload and returns it.
func (p *provisionPlan) uploadDirLocked(root string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.uploads.closed {
		return "", errUploadsClosed
	}
	if p.uploads.dir != "" {
		return p.uploads.dir, nil
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	d, err := os.MkdirTemp(root, "plan-")
	if err != nil {
		return "", err
	}
	if err := os.Chmod(d, 0o700); err != nil {
		os.RemoveAll(d)
		return "", err
	}
	p.uploads.dir = d
	if p.uploads.files == nil {
		p.uploads.files = map[string]uploadedFile{}
	}
	return d, nil
}

// removeUploads deletes the plan's uploaded files (the run ended, the plan was cancelled or expired).
func (p *provisionPlan) removeUploads() {
	p.mu.Lock()
	d := p.uploads.dir
	p.uploads.dir, p.uploads.files, p.uploads.closed = "", nil, true
	p.mu.Unlock()
	if d != "" {
		_ = os.RemoveAll(d)
	}
}

// uploadedFor is what the installer is given: the paths of this plan's uploaded files.
func (p *provisionPlan) uploadedFor() sshprov.Upload {
	p.mu.Lock()
	defer p.mu.Unlock()
	return sshprov.Upload{Package: p.uploads.files["package"].path, Sums: p.uploads.files["sums"].path, Bundle: p.uploads.files["bundle"].path}
}

// uploadsView is the page's view of what was uploaded: the size and SHA-256 of each file, never a path.
func (p *provisionPlan) uploadsViewLocked() map[string]any {
	out := map[string]any{}
	for k, f := range p.uploads.files {
		out[k] = map[string]any{"bytes": f.bytes, "sha256": f.sha256}
	}
	return out
}
