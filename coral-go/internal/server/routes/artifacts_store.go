// The artifact store: where objects and their sidecars live, the size limit and its accounting, and the atomic writes that store an object. Moved out of artifacts.go (#8314), no code changed.

package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/fsreplace"
	"github.com/subgentic/coral/internal/safefs"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

// uploadsDir is where per-session upload records live. The session id is
// rejected unless it is a plain name, so it cannot escape the directory.
func uploadsDir(coralDir, sessionID string) string {
	// One safe path element: [A-Za-z0-9_-], at most 128, starting with a letter or digit, so
	// never ".", "..", a separator, a drive ("C:") or a Windows device-like name (#3602 W26).
	if coralDir == "" || !safefs.IsSafeID(sessionID) {
		return ""
	}
	return filepath.Join(coralDir, "artifacts", "uploads", sessionID)
}

// ArtifactStoreMaxBytesSetting caps the artifact store's size in bytes (#3553). Unset (or blank) is the default,
// defaultArtifactStoreMaxBytes (#4602: a store with no cap grows until the disk is full); a stored 0 is no cap, the Operator's choice.
const ArtifactStoreMaxBytesSetting = "artifact_store_max_bytes"

// defaultArtifactStoreMaxBytes is the cap when the Operator has set none: 20 GiB. Above it new uploads are refused, nothing is
// deleted (#4602, the Orchestrator's decision 2); Settings > Storage and cleanup shows the store from 80% of it.
const defaultArtifactStoreMaxBytes int64 = 20 << 30

// artifactStoreRefuse is the cap when the setting can't be read: one byte, so the store takes nothing new
// rather than having no cap (#4432, Security's #4431 SHOULD 2).
const artifactStoreRefuse int64 = 1

// ArtifactStoreAutoRaisedSetting is Coral's own record that it raised the store's limit at startup (RaiseArtifactStoreLimitIfOver): the
// limit it wrote, in bytes. Settings > Storage and cleanup shows a note while the saved limit is still that number, and says nothing once the Operator
// has chosen another.
const ArtifactStoreAutoRaisedSetting = "artifact_store_auto_raised"

// RaiseArtifactStoreLimitIfOver is run once at startup (#4602, the Orchestrator's rule for the 20 GiB default). A Coral that has no limit
// set and a store already at 80% of the default (16 GiB) or more would start refusing uploads the moment it upgraded, with nobody
// watching: so the limit is written once, as twice the store's size rounded up to a whole GiB, and logged. It writes a setting and
// deletes nothing; an Operator's own value (0 included) is never changed. It reports the limit it wrote, 0 when it wrote none.
func RaiseArtifactStoreLimitIfOver(ctx context.Context, ss *store.SessionStore, coralDir string) int64 {
	if ss == nil {
		return 0
	}
	settings, err := ss.GetSettings(ctx)
	if err != nil || strings.TrimSpace(setreg.Raw(settings, ArtifactStoreMaxBytesSetting)) != "" {
		return 0
	}
	used, _, _ := storeFor(coralDir).size()
	if used*5 < defaultArtifactStoreMaxBytes*4 {
		return 0
	}
	const gib = int64(1) << 30
	limit := (2*used + gib - 1) / gib * gib
	if err := ss.SetSetting(ctx, ArtifactStoreMaxBytesSetting, strconv.FormatInt(limit, 10)); err != nil {
		slog.Warn("artifact store: could not raise its limit above the new default", "used", used, "error", err)
		return 0
	}
	if err := ss.SetSetting(ctx, ArtifactStoreAutoRaisedSetting, strconv.FormatInt(limit, 10)); err != nil {
		slog.Warn("artifact store: raised its limit but could not record it", "error", err)
	}
	slog.Info("artifact store: it already held more than 80% of the new 20 GiB default, so its limit was raised once to twice its size; change it in Settings > Storage and cleanup",
		"used", humanBytes(used), "limit", humanBytes(limit))
	return limit
}

func (h *SessionsHandler) artifactStoreMaxBytes() int64 {
	if h.ss == nil {
		return 0
	}
	s, err := h.ss.GetSettings(context.Background())
	if err != nil {
		return artifactStoreRefuse
	}
	if strings.TrimSpace(setreg.Raw(s, ArtifactStoreMaxBytesSetting)) == "" {
		return defaultArtifactStoreMaxBytes
	}
	n, ok := parseStoreCap(setreg.Raw(s, ArtifactStoreMaxBytesSetting))
	if !ok {
		slog.Warn("artifact_store_max_bytes is not a whole number of bytes; the store takes nothing new until it is set again", "value", setreg.Raw(s, ArtifactStoreMaxBytesSetting))
		return artifactStoreRefuse
	}
	return n
}

// parseStoreCap reads the cap: empty is 0 (no cap); a whole number of bytes, also in the exponent form older
// versions stored a large one in ("1.073741824e+10"). ok is false for anything else.
func parseStoreCap(v string) (int64, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, true
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		return n, n >= 0
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 || f != math.Trunc(f) || f > 1<<53 {
		return 0, false
	}
	return int64(f), true
}

// getArtifactStore: GET /api/system/artifact-store, the object store's size, object count and
// cap, and, as separate lines, the saved task and session diffs (artifacts/tasks and
// artifacts/sessions), which the cap doesn't cover (#3553; Settings shows them). Not in the
// tunnel table: this computer only.
func (h *SessionsHandler) getArtifactStore(w http.ResponseWriter, r *http.Request) {
	coralDir := h.cfg.CoralDir()
	b, n, max := storeFor(coralDir).size()
	tb, tn, sb, sn := diffStoreSizes(coralDir)
	out := map[string]any{
		"bytes": b, "objects": n, "max_bytes": max,
		"task_diffs":    map[string]int64{"bytes": tb, "files": tn},
		"session_diffs": map[string]int64{"bytes": sb, "files": sn},
	}
	// The limit Coral raised by itself at startup (RaiseArtifactStoreLimitIfOver), while it is still the saved limit.
	if h.ss != nil {
		if saved, err := h.ss.GetSettings(r.Context()); err == nil && setreg.Raw(saved, ArtifactStoreAutoRaisedSetting) != "" && setreg.Raw(saved, ArtifactStoreAutoRaisedSetting) == setreg.Raw(saved, ArtifactStoreMaxBytesSetting) {
			if n, err := strconv.ParseInt(setreg.Raw(saved, ArtifactStoreAutoRaisedSetting), 10, 64); err == nil {
				out["auto_raised"] = n
			}
		}
	}
	out["received"] = h.receivedStatus(isOperatorRequest(r)) // #4441: the total received from other Corals and boards, its cap and the one-time notice; the digests of the unlisted files only for the Operator (#4489)
	// ?detail=1 (#3554): by age, by board, kept and retention, for Settings > Storage and cleanup.
	if r.URL.Query().Get("detail") == "1" {
		if detail, err := h.storageDetail(r.Context()); err == nil {
			out["detail"] = detail
		} else {
			out["detail_error"] = "could not read the store's details"
		}
	}
	writeJSON(w, http.StatusOK, out)
}

var diffSizes struct {
	sync.Mutex
	dir    string
	at     time.Time
	tb, tn int64
	sb, sn int64
}

// diffStoreSizes walks artifacts/tasks and artifacts/sessions (regular files only, no links
// followed), at most every 30 s.
func diffStoreSizes(coralDir string) (tb, tn, sb, sn int64) {
	diffSizes.Lock()
	defer diffSizes.Unlock()
	if diffSizes.dir == coralDir && time.Since(diffSizes.at) < 30*time.Second {
		return diffSizes.tb, diffSizes.tn, diffSizes.sb, diffSizes.sn
	}
	// A diff shared by several tasks or sessions is one file with several hard links (#3555's
	// dedupe): its bytes count once, under the first place it's found; files counts the
	// task and session diffs (the links). QA's #3555 finding.
	seen := map[string]bool{}
	walk := func(dir string) (bytes, files int64) {
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil || !d.Type().IsRegular() {
				return nil
			}
			if info, ierr := d.Info(); ierr == nil {
				files++
				if key, ok := fileIdentity(p, info); ok {
					if seen[key] {
						return nil
					}
					seen[key] = true
				}
				bytes += info.Size()
			}
			return nil
		})
		return
	}
	tb, tn = walk(filepath.Join(coralDir, "artifacts", "tasks"))
	sb, sn = walk(filepath.Join(coralDir, "artifacts", "sessions"))
	diffSizes.dir, diffSizes.at = coralDir, time.Now()
	diffSizes.tb, diffSizes.tn, diffSizes.sb, diffSizes.sn = tb, tn, sb, sn
	return
}

func (h *SessionsHandler) artifactDir() string {
	return filepath.Join(h.cfg.CoralDir(), "artifacts", "objects")
}

// storeArtifact writes data as a content-addressed artifact object under coralDir (the
// object, its metadata sidecar, and the session's upload record, so the agent's
// Artifacts tab lists it) and returns its hex id and the artifact's stored metadata. Shared
// by coral-agent artifact upload and the board's auto-attach (#3515).
//
// #3552 (Security's #3551 audit): the first writer's name and type stay. The sidecar is
// created once (an exclusive hard link from a temp file) and never rewritten, so uploading
// the same bytes again can't relabel someone else's artifact; each uploader's own name is
// kept in its uploads/<session>/<hex>.json record. The object is written to a temp file and
// renamed into place before the sidecar exists, so a sidecar never points at a partial
// object. Folders are 0700 and files 0600.
func storeArtifact(coralDir, sessionID, name, mediaType string, data []byte) (string, agentArtifactMeta, error) {
	return storeArtifactBy(coralDir, sessionID, name, mediaType, "", "", data)
}

// storeArtifactBy is storeArtifact with the uploader and the record's source named ("owner" and "paste" for the dashboard, #5284); "" and "" is the agent itself.
func storeArtifactBy(coralDir, sessionID, name, mediaType, uploadedBy, source string, data []byte) (string, agentArtifactMeta, error) {
	return storeArtifactVia(coralDir, sessionID, name, mediaType, uploadedBy, source, "", data)
}

// storeArtifactVia is storeArtifactBy for an image that came through Coral Hub: hubUser (hub-user-<8 hex>, or "") is kept on the upload record (#6088).
func storeArtifactVia(coralDir, sessionID, name, mediaType, uploadedBy, source, hubUser string, data []byte) (string, agentArtifactMeta, error) {
	digestBytes := sha256.Sum256(data)
	hexID := hex.EncodeToString(digestBytes[:])
	defer lockArtifact(hexID)() // a delete of the same digest waits (#3553)
	mine := agentArtifactMeta{Name: name, MediaType: mediaType, Size: int64(len(data)), Digest: "sha256:" + hexID}
	dir := filepath.Join(coralDir, "artifacts", "objects")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", mine, err
	}
	objectPath := filepath.Join(dir, hexID)
	if _, err := os.Stat(objectPath); os.IsNotExist(err) {
		// The store's cap (#3553) is decided here, for new objects only: bytes already stored
		// are never refused.
		st := storeFor(coralDir)
		if !st.fits(int64(len(data))) {
			return "", mine, errStoreFull
		}
		if err := writeFileAtomic(objectPath, data, 0o600); err != nil {
			return "", mine, err
		}
		st.added(int64(len(data)))
	}
	stored, err := createSidecarOnce(objectPath+".json", mine)
	if err != nil {
		return "", mine, err
	}
	if up := uploadsDir(coralDir, sessionID); up != "" {
		if os.MkdirAll(up, 0o700) == nil {
			r := newUploadRecord(mine, sessionID, uploadedBy, source)
			r.HubUser = hubUser
			rec, _ := json.Marshal(r)
			_ = writeFileAtomic(filepath.Join(up, hexID+".json"), rec, 0o600)
		}
	}
	return hexID, stored, nil
}

// writeFileAtomic writes data to a temp file in path's folder and renames it into place.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil { // on disk before it gets the real name
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		return err
	}
	return fsreplace.Rename(tmp.Name(), path)
}

// createSidecarOnce stores meta as the artifact's sidecar unless one exists, and returns
// the sidecar's metadata (the first writer's). The sidecar appears whole or not at all: a
// complete temp file is hard-linked to the name, which fails if the name exists.
func createSidecarOnce(path string, meta agentArtifactMeta) (agentArtifactMeta, error) {
	if existing, ok := readSidecar(path); ok {
		return existing, nil
	}
	data, _ := json.Marshal(meta)
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return meta, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return meta, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return meta, err
	}
	if err := tmp.Close(); err != nil {
		return meta, err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return meta, err
	}
	link := os.Link
	if sidecarLinkHook != nil {
		link = func(string, string) error { return sidecarLinkHook() }
	}
	if err := link(tmp.Name(), path); err != nil {
		if existing, ok := readSidecar(path); ok { // another upload of the same bytes won
			return existing, nil
		}
		if !os.IsExist(err) {
			// A file system without hard links: an exclusive create and a full write.
			return createSidecarExclusive(path, meta, data)
		}
		return meta, err
	}
	return meta, nil
}

// sidecarLinkHook lets a test make the hard link fail, as on a file system without them.
var sidecarLinkHook func() error

// createSidecarExclusive is createSidecarOnce without a hard link: O_EXCL creates the name
// (the first writer wins), and the data is written and synced at once.
func createSidecarExclusive(path string, meta agentArtifactMeta, data []byte) (agentArtifactMeta, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if existing, ok := readSidecar(path); ok {
			return existing, nil
		}
		return meta, err
	}
	_, werr := f.Write(data)
	serr := f.Sync()
	cerr := f.Close()
	if werr != nil || serr != nil || cerr != nil {
		os.Remove(path)
		return meta, fmt.Errorf("write sidecar: %v %v %v", werr, serr, cerr)
	}
	return meta, nil
}

func readSidecar(path string) (agentArtifactMeta, bool) {
	var m agentArtifactMeta
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &m) != nil || m.Digest == "" {
		return m, false
	}
	return m, true
}
