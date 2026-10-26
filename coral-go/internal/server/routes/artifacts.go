package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/mediatype"
	"github.com/subgentic/coral/internal/secfile"
)

const maxAgentArtifactSize = 64 << 20

type agentArtifactMeta struct {
	Name      string `json:"name"`
	MediaType string `json:"media_type"`
	Size      int64  `json:"size"`
	Digest    string `json:"digest"`
}

// agentUploadRecord is a per-session record of an upload, so an agent's
// Artifacts tab lists what it uploaded before (or without) attaching it to a
// task result.
type agentUploadRecord struct {
	agentArtifactMeta
	CreatedAt string `json:"created_at"`
	// UploadedBy is who put it there when it was not the agent: "owner" for an image pasted or attached in the dashboard (#5284). Absent on an agent's own upload.
	UploadedBy string `json:"uploaded_by,omitempty"`
	// Source is "paste" for such an image. It follows the uploads retention, the switch that keeps it from Coral Hub viewers, and is not an upload of the agent (a task result cannot name it).
	Source string `json:"source,omitempty"`
	// Board, Uploader and Role say who made it, as they were at the upload (#5575): the board's id, the agent's name and its role there. Absent on a record made before they were kept
	// (the Operator's Artifacts tab then says "unknown") and on a received file, which no agent here uploaded.
	Board    string `json:"board,omitempty"`
	Uploader string `json:"uploader,omitempty"`
	Role     string `json:"role,omitempty"`
	// OwnerKind and OwnerID say who owns this record (#5577): "operator" (the machine owner) or "hub_user" and its id. Recorded at the upload from authentication (an agent's team's owner;
	// the operator for a dashboard paste). Absent on a record made before they were kept: the machine owner's.
	OwnerKind string `json:"owner_kind,omitempty"`
	OwnerID   string `json:"owner_id,omitempty"`
	// HubUser is the Coral Hub account (hub-user-<8 hex>, never a name or an email) that sent an image through Coral Hub (#6088); UploadedBy stays "owner". Absent on an image from this computer's own dashboard.
	HubUser string `json:"hub_user,omitempty"`
	// SeriesID, Version and Previous say that this upload is a version of an artifact series (#6357): the series' id (32 hex), this version's number and the digest of the one before it. They are
	// here and never in the sidecar, which every upload of the same bytes shares; this record is the authority for what is in a series.
	SeriesID string `json:"series_id,omitempty"`
	Version  int    `json:"version,omitempty"`
	Previous string `json:"previous,omitempty"`
	// TaskID is the task of the uploader's board this upload is linked to (#7739): the agent's one task in progress at the upload, or the one it named. Absent on a person's upload and on one made
	// with no task. It is checked against the board when the list is made (a task that is not on the team's board is not shown).
	TaskID int64 `json:"task_id,omitempty"`
}

// sourcePaste marks an upload record made from an image pasted or attached in the dashboard.
const sourcePaste = "paste"

// RegisterAgentArtifacts adds Coral-managed, durable artifact storage. Uploads
// are authenticated through the calling agent session; downloads use the
// opaque digest ID so task hand-offs remain reachable by other agents/users.
func (h *SessionsHandler) RegisterAgentArtifacts(r chi.Router) {
	// The store's size is measured now, before any upload (#3553), and capped by the setting.
	st := storeFor(h.cfg.CoralDir())
	st.mu.Lock()
	st.maxBytes = h.artifactStoreMaxBytes
	st.receivedMaxBytes = h.receivedArtifactsMaxBytes
	st.mu.Unlock()
	r.Post("/api/agent/artifacts", h.uploadAgentArtifact)
	r.Get("/api/artifacts", h.listAllArtifacts)                           // the machine-wide list, the owner's (#5575)
	r.Get("/api/artifacts/series/{series_id}", h.seriesRedirect)          // #6357: the newest version the caller can read (a redirect to its digest)
	r.Get("/api/artifacts/series/{series_id}/versions", h.seriesVersions) // #6357
	r.Delete("/api/artifacts/series/{series_id}", h.deleteSeries)         // #6357: the Operator's, every version
	r.Get("/api/artifacts/{id}", h.getAgentArtifact)
	r.Get("/api/artifacts/{id}/meta", h.getAgentArtifactMeta) // metadata only: do you have it (#5465)
	r.Get("/api/artifacts/{id}/versions", h.artifactVersions) // #6357: the list of its series, found from any version
	r.Get("/api/artifacts/{id}/readers", h.artifactReaders)   // who can read it, for its owner (#5577)
	r.Delete("/api/artifacts/{id}", h.deleteAgentArtifact)
	r.Delete("/api/shared-images/{id}", h.deleteSharedImage)                         // #5284: one session's shared copy of a pasted image
	r.Post("/api/artifacts/received/unlisted/delete", h.deleteUnlistedReceivedRoute) // #4441
	r.Get("/api/system/artifact-store/kept", h.keptListRoute)                        // #3554
	r.Post("/api/artifacts/prune", h.pruneArtifactsRoute)
	r.Post("/api/artifacts/retention/ack", h.retentionAckRoute) // #3554
	r.Put("/api/artifacts/{id}/keep", h.keepArtifactRoute)      // #3554
	r.Delete("/api/artifacts/{id}/keep", h.keepArtifactRoute)   // #3554
	r.Get("/api/system/artifact-store", h.getArtifactStore)
}

func (h *SessionsHandler) uploadAgentArtifact(w http.ResponseWriter, r *http.Request) {
	sid := r.URL.Query().Get("session_id")
	if _, ok := h.agentFromRequest(w, r, &sid, false); !ok {
		return
	}
	name := strings.TrimSpace(r.Header.Get("X-Artifact-Name"))
	if name == "" || !board.ValidLabel(name, 160) { // plain text: the name goes into cross-team messages typed into agents' terminals (#4901)
		errBadRequest(w, "X-Artifact-Name must be 1–160 characters of plain text, with no control or formatting characters")
		return
	}
	if !board.ValidLabel(strings.TrimSpace(r.Header.Get("X-Artifact-Media-Type")), 127) {
		errBadRequest(w, "X-Artifact-Media-Type must be at most 127 characters of plain text, with no control or formatting characters")
		return
	}
	mediaType := mediatype.Resolve(r.Header.Get("X-Artifact-Media-Type"), name)
	if mediaType == "" {
		mediaType = mediatype.Generic
	}
	taskID, refused := h.artifactTaskLink(r.Context(), r) // before a byte is read: a task that cannot be named stores nothing (#7739)
	if refused != "" {
		errNotFound(w, refused)
		return
	}
	if refuseIfDiskLow(w) {
		return
	}
	coralDir := h.cfg.CoralDir()
	st := storeFor(coralDir)
	// The hourly cap is per agent session (its verified token); token-less uploads, possible
	// only in default mode, share one bucket rather than having none (#3553).
	key := sharedUploadBucket
	if owner, ok := VerifiedSession(r.Context()); ok && owner.SessionID != "" {
		key = "session:" + owner.SessionID
	}
	if ok, retry := st.admitUpload(key); !ok {
		artifactHourlyLimited(w, retry,
			fmt.Sprintf("this agent's upload limit for the hour is used up (%d uploads or %d MiB); try again in %s", uploadWindowCount, uploadWindowBytes>>20, retry.Round(time.Minute)))
		return
	}

	// Streamed into a temp file next to the objects while hashing (no io.ReadAll, #3553).
	dir := filepath.Join(coralDir, "artifacts", "objects")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		errInternalServer(w, "could not store the artifact")
		return
	}
	tmp, err := os.CreateTemp(dir, artifactUploadTempP+"*")
	if err != nil {
		errInternalServer(w, "could not store the artifact")
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // a no-op once it has been renamed into the store
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hash), http.MaxBytesReader(w, r.Body, maxAgentArtifactSize+1))
	closeErr := tmp.Close()
	withinWindow := st.chargeUpload(key, n) // what was read counts, stored or refused
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) || n > maxAgentArtifactSize {
		artifactRefusal(w, http.StatusRequestEntityTooLarge, "artifact_too_large", "", "artifact exceeds 64 MiB")
		return
	}
	if err != nil || closeErr != nil {
		errBadRequest(w, "the upload was cut short")
		return
	}
	if !withinWindow {
		artifactHourlyLimited(w, 0, // the byte window's reset time isn't tracked here; no Retry-After.
			fmt.Sprintf("this agent's upload limit for the hour is used up (%d MiB); try again later", uploadWindowBytes>>20))
		return
	}
	hexID, size := hex.EncodeToString(hash.Sum(nil)), n

	// An image is recognised by its bytes, whatever its declared type, and stored without its
	// metadata, or refused when its format can't be stripped (finding 5). Its id is then the
	// hash of the stored bytes.
	stripped := false
	if head, herr := readHead(tmpPath, 16); herr == nil && sniffImageFamily(head) != "" {
		data, rerr := os.ReadFile(tmpPath)
		if rerr != nil {
			errInternalServer(w, "could not store the artifact")
			return
		}
		clean, changed, cerr := cleanUploadedImage(data)
		if cerr != nil {
			artifactRefusal(w, http.StatusBadRequest, "image_metadata", "", cerr.Error())
			return
		}
		if changed {
			if werr := os.WriteFile(tmpPath, clean, 0o600); werr != nil {
				errInternalServer(w, "could not store the artifact")
				return
			}
			sum := sha256.Sum256(clean)
			hexID, size, stripped = hex.EncodeToString(sum[:]), int64(len(clean)), true
		}
	}

	// A new version of an artifact (#6357): worked out under the series lock, which is held until the object, its record and the index are written (the series lock first, the digest's after).
	var plan *seriesPlan
	var stamp *seriesStamp
	if ref := strings.TrimSpace(r.Header.Get(seriesHeader)); ref != "" {
		callerBoard, _, _ := uploaderOf(sid)
		var perr error
		if plan, perr = planNewVersion(coralDir, ref, callerBoard, hexID); perr != nil {
			h.answerSeriesRefusal(w, coralDir, hexID, perr)
			return
		}
		defer plan.unlock()
		if plan.same != nil { // the bytes are the newest version: nothing is added, and that version is the answer (exit 0)
			h.answerExistingVersion(w, coralDir, plan, *plan.same)
			return
		}
		stamp = &plan.stamp
	}
	meta, fresh, err := storeArtifactFile(coralDir, sid, name, mediaType, tmpPath, hexID, size, stamp, taskID)
	if errors.Is(err, errStoreFull) {
		b, _, max := st.size()
		artifactRefusal(w, http.StatusRequestEntityTooLarge, "artifact_quota", "store",
			fmt.Sprintf("the artifact store is full (%s of %s): ask the Operator to delete old artifacts or raise the limit (Settings > Storage; artifact_store_max_bytes, 0 for none)", humanBytes(b), humanBytes(max)))
		return
	}
	if err != nil {
		errInternalServer(w, "could not store the artifact")
		return
	}
	_ = fresh
	h.noteOffBooksUpload(r.Context(), taskID, hexID) // an agent with no task in progress: a line of the orchestrator's check (#7793)
	// The name and type viewers get: the first upload's, when these bytes were stored before.
	reply := map[string]any{
		"uri":        "coral://artifacts/" + hexID,
		"url":        artifactURL(hexID),
		"name":       meta.Name,
		"media_type": meta.MediaType,
		"size":       meta.Size, // the stored size: smaller than the file when metadata was removed
		"digest":     meta.Digest,
		"stripped":   stripped, // image metadata was removed: the id is the hash of the stored bytes
	}
	if taskID > 0 {
		reply["task_id"] = taskID // the task the upload is linked to (#7739)
	}
	if plan == nil {
		// Bytes that are already a version of their own board's series say so (#6495): a script that uploaded v1 again needs not read the series back. Only the uploading board's own series
		// (the first version's board is the caller's): another team's series id never leaves this computer for a caller who merely holds the same bytes.
		if callerBoard, _, _ := uploaderOf(sid); callerBoard != "" {
			if sidOf, n, in := digestSeries(coralDir, hexID); in {
				if ms := seriesMembers(coralDir, sidOf); len(ms) > 0 && ms[0].Board == callerBoard {
					reply["series_id"], reply["version"], reply["versions"] = sidOf, n, len(ms)
				}
			}
		}
	}
	if plan != nil {
		versions, cerr := plan.commit(coralDir, hexID, sid)
		if cerr != nil {
			slog.Warn("[artifacts] a new version was stored but its series could not be recorded", "series", plan.id, "error", cerr)
			errInternalServer(w, "the artifact was stored but its series could not be recorded")
			return
		}
		reply["series_id"], reply["version"], reply["versions"] = plan.id, plan.stamp.Version, versions
		slog.Info("[artifacts] a new version", "series", plan.id, "version", plan.stamp.Version, "digest", hexID, "session", sid) // one audit line per version: who, which series, which digest, no content
	}
	writeJSON(w, http.StatusCreated, reply)
}

// answerSeriesRefusal writes a refused new version's answer: the refusal's own code and words (all of them generic where they would otherwise name another team's series); a 200 "refusal" is the
// bytes being the artifact the upload is a version of, answered as that artifact.
func (h *SessionsHandler) answerSeriesRefusal(w http.ResponseWriter, coralDir, hexID string, err error) {
	ref, ok := err.(*seriesRefusal)
	if !ok {
		errInternalServer(w, "could not store the artifact")
		return
	}
	if ref.status == http.StatusOK {
		body := map[string]any{"uri": "coral://artifacts/" + hexID, "url": artifactURL(hexID), "digest": "sha256:" + hexID, "message": ref.msg, "same": true}
		if m, found := readSidecar(filepath.Join(coralDir, "artifacts", "objects", hexID+".json")); found {
			body["name"], body["media_type"], body["size"] = m.Name, m.MediaType, m.Size
		}
		writeJSON(w, http.StatusOK, body)
		return
	}
	artifactRefusal(w, ref.status, ref.code, "", ref.msg)
}

// answerExistingVersion answers an upload whose bytes are the newest version of its series: that version, as stored, with the series' numbers.
func (h *SessionsHandler) answerExistingVersion(w http.ResponseWriter, coralDir string, plan *seriesPlan, latest seriesMember) {
	body := map[string]any{"uri": "coral://artifacts/" + latest.Digest, "url": artifactURL(latest.Digest), "digest": "sha256:" + latest.Digest, "series_id": plan.id, "version": latest.N, "versions": len(plan.rows), "same": true,
		"message": "these bytes are the newest version: nothing was added"}
	if m, found := readSidecar(filepath.Join(coralDir, "artifacts", "objects", latest.Digest+".json")); found {
		body["name"], body["media_type"], body["size"] = m.Name, m.MediaType, m.Size
	}
	writeJSON(w, http.StatusOK, body)
}

var errStoreFull = errors.New("artifact store is full")

// storeArtifactFile moves an already hashed temp file (in the objects folder) into the store as
// hexID, with its sidecar and the session's upload record (#3553: the streamed counterpart of
// storeArtifact). An object that is already stored makes it a free duplicate. It refuses a new
// object that would take the store past its cap. fresh reports whether the object is new.
func storeArtifactFile(coralDir, sessionID, name, mediaType, tmpPath, hexID string, size int64, stamp *seriesStamp, taskID int64) (agentArtifactMeta, bool, error) {
	defer lockArtifact(hexID)()
	mine := agentArtifactMeta{Name: name, MediaType: mediaType, Size: size, Digest: "sha256:" + hexID}
	st := storeFor(coralDir)
	objectPath := filepath.Join(coralDir, "artifacts", "objects", hexID)
	fresh := false
	if _, err := os.Stat(objectPath); os.IsNotExist(err) {
		if !st.fits(size) {
			return mine, false, errStoreFull
		}
		if err := os.Chmod(tmpPath, 0o600); err != nil {
			return mine, false, err
		}
		if err := os.Rename(tmpPath, objectPath); err != nil {
			return mine, false, err
		}
		st.added(size)
		fresh = true
	}
	// As storeArtifact (#3552): the first writer's sidecar stays; this uploader's name is kept
	// in its own upload record.
	stored, err := createSidecarOnce(objectPath+".json", mine)
	if err != nil {
		// An object without a sidecar can't be served (GET is 404) but would still count
		// against the store: remove the one just added (Security's #3553 review).
		if fresh && os.Remove(objectPath) == nil {
			st.removed(size)
		}
		return mine, false, err
	}
	if up := uploadsDir(coralDir, sessionID); up != "" {
		if os.MkdirAll(up, 0o700) == nil {
			ur := newUploadRecord(mine, sessionID, "", "")
			if stamp != nil { // a version of a series: the record says which (#6357)
				ur.SeriesID, ur.Version, ur.Previous = stamp.ID, stamp.Version, stamp.Previous
			}
			recPath := filepath.Join(up, hexID+".json")
			switch {
			case taskID > 0:
				ur.TaskID = taskID
			case taskID == 0: // no task this time: the link an earlier upload of the same bytes made stays
				if old, err := os.ReadFile(recPath); err == nil {
					var prev agentUploadRecord
					if json.Unmarshal(old, &prev) == nil {
						ur.TaskID = prev.TaskID
					}
				}
			}
			rec, _ := json.Marshal(ur)
			_ = writeFileAtomic(recPath, rec, 0o600)
		}
	}
	return stored, fresh, nil
}

// readHead reads up to n bytes from the start of path.
func readHead(path string, n int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, n)
	k, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return buf[:k], nil
}

// artifactRefusal answers an upload Coral won't store, with a code the CLI can tell apart:
// artifact_too_large, artifact_quota (limit "hourly" or "store") or image_metadata.
func artifactRefusal(w http.ResponseWriter, status int, code, limit, msg string) {
	body := map[string]string{"error": msg, "code": code, "message": msg}
	if limit != "" {
		body["limit"] = limit
	}
	writeJSON(w, status, body)
}

// artifactHourlyLimited refuses an upload that hit an hourly rate cap with 429 Too Many Requests
// (#4007: a count/byte window is a rate limit, not a too-large file; 413 stays for one oversized
// file and for the store cap). Retry-After (whole seconds) is set when the reset time is known.
func artifactHourlyLimited(w http.ResponseWriter, retryIn time.Duration, msg string) {
	secs := 0
	if retryIn > 0 {
		secs = int((retryIn + time.Second - 1) / time.Second)
	}
	// A per-action limit (X-Coral-Limit: action), so a dashboard never takes it for an overloaded server.
	httputil.WriteActionLimitBody(w, secs, map[string]string{"error": msg, "code": "artifact_quota", "message": msg, "limit": "hourly"})
}

// humanBytes shows a size rounded down (so a store just under its cap never reads as full):
// bytes under 1 KiB, else KiB, MiB or GiB to one decimal.
func humanBytes(n int64) string {
	unit := func(div float64, name string) string {
		return fmt.Sprintf("%.1f %s", math.Floor(float64(n)/div*10)/10, name)
	}
	switch {
	case n >= 1<<30:
		return unit(1<<30, "GiB")
	case n >= 1<<20:
		return unit(1<<20, "MiB")
	case n >= 1<<10:
		return unit(1<<10, "KiB")
	}
	return fmt.Sprintf("%d B", n)
}

// artifactIDRe is the whole of an artifact id: exactly 64 lower-case hexadecimal digits, the SHA-256 of its bytes (#5465). Upper case, another length, a prefix such as
// "sha256:", a path or anything else is not an id: on a file system that ignores case an upper-case spelling would otherwise name the same object under another name.
var artifactIDRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// validArtifactID reports whether id is an artifact id (artifactIDRe).
func validArtifactID(id string) bool { return artifactIDRe.MatchString(id) }

// openArtifactForRead is what the content read and the metadata read share (#5465), so that they answer the same for the same id: the owner's switch for a pasted image
// through Coral Hub (404), a missing or unreadable record or object (404), and a stored object whose length disagrees with its record (500, artifact_corrupt: a damaged store
// is said, not served). The object is opened once, without following a link, and the caller uses that handle. On false the answer has been written.
func (h *SessionsHandler) openArtifactForRead(w http.ResponseWriter, r *http.Request, id string) (*os.File, agentArtifactMeta, os.FileInfo, bool) {
	// The one read check (#5577), before the record or the object is touched: an agent that may not read this answers exactly as for an artifact that does not exist.
	if !artifactReadable(r, h.cfg.CoralDir(), id) {
		errNotFound(w, "artifact not found")
		return nil, agentArtifactMeta{}, nil, false
	}
	path := filepath.Join(h.artifactDir(), id)
	meta := agentArtifactMeta{}
	metaData, err := os.ReadFile(path + ".json")
	if err != nil || json.Unmarshal(metaData, &meta) != nil {
		errNotFound(w, "artifact not found")
		return nil, agentArtifactMeta{}, nil, false
	}
	// The object is opened once and served from that handle, its length from the file itself
	// (Security's #4438 INFO 4): a sidecar that disagrees with the file means the store is corrupt,
	// and the download is refused rather than sent with a length that doesn't match its bytes.
	f, err := secfile.OpenNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		errNotFound(w, "artifact not found")
		return nil, agentArtifactMeta{}, nil, false
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		errNotFound(w, "artifact not found")
		return nil, agentArtifactMeta{}, nil, false
	}
	if info.Size() != meta.Size {
		f.Close()
		slog.Warn("[artifacts] stored object and its sidecar disagree on the size; not served", "digest", id, "file_bytes", info.Size(), "sidecar_bytes", meta.Size)
		writeError(w, http.StatusInternalServerError, "artifact_corrupt", "this artifact's stored copy is damaged")
		return nil, agentArtifactMeta{}, nil, false
	}
	return f, meta, info, true
}

func (h *SessionsHandler) getAgentArtifact(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone (#5575)
		return
	}
	id := chi.URLParam(r, "id")
	if !validArtifactID(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	// The link form (#3168): /api/artifacts/<digest>?v=2. The tunnel accepts exactly that, so the
	// handler does too: v absent or 2, nothing else (#3179).
	if q := r.URL.Query(); q.Has("v") && (len(q["v"]) != 1 || q.Get("v") != "2") {
		errBadRequest(w, "invalid artifact link version")
		return
	}
	f, meta, info, ok := h.openArtifactForRead(w, r, id)
	if !ok {
		return
	}
	defer f.Close()
	// An agent chose these bytes and their type: an HTML or SVG upload must not
	// run on the dashboard's origin when someone opens its link.
	setUntrustedContentHeaders(w.Header(), meta.MediaType, meta.Name)
	// The bytes never change for an id, but an artifact can be deleted (#3553): private, so no
	// shared cache (in front of Coral Hub, a proxy) keeps serving it after that.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	// The server's build header (server.buildHeader) is per answer, not per object: a browser keeping this answer for a year would later hand the dashboard an
	// old build's id and trip its "Coral was updated" banner on every Preview (#5312). An immutable answer names no build.
	w.Header().Del("X-Coral-Build")
	http.ServeContent(w, r, "", info.ModTime(), f) // Content-Length (and ranges) from the open file
}

// getAgentArtifactMeta answers "do you have this artifact?" without its bytes (#5465, coral-hub). GET /api/artifacts/{id}/meta
//
// {"id": "<64 hex>", "size": <bytes of the stored object>, "media_type": "<what a download is served as>", "name": "<the name it was stored under>"} (name only when it has one).
// It is the content read with the bytes left out: the same id check, the same 404 when the artifact is absent or hidden from Coral Hub by the paste share switch, the same refusal of a damaged
// copy, from the same code (openArtifactForRead); no query parameter is read. The answer is never cached (no-store): an artifact can be deleted at any time.
func (h *SessionsHandler) getAgentArtifactMeta(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone (#5575)
		return
	}
	id := chi.URLParam(r, "id")
	if !validArtifactID(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	f, meta, info, ok := h.openArtifactForRead(w, r, id)
	if !ok {
		return
	}
	f.Close()
	// The type a download is served as, from the same function: an unknown or malformed one is application/octet-stream there, and here.
	served := http.Header{}
	setUntrustedContentHeaders(served, meta.MediaType, meta.Name)
	out := map[string]any{"id": id, "size": info.Size(), "media_type": served.Get("Content-Type")}
	if meta.Name != "" {
		out["name"] = meta.Name
	}
	if h.anySeries() { // #6357: additive, only on a version of a series (the walk is skipped while the store has none)
		if sid, n, in := digestSeries(h.cfg.CoralDir(), id); in {
			ms := seriesMembers(h.cfg.CoralDir(), sid)
			out["series_id"], out["version"], out["versions"], out["is_latest"] = sid, n, len(ms), len(ms) > 0 && ms[len(ms)-1].Digest == id
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Del("X-Coral-Build")
	writeJSON(w, http.StatusOK, out)
}
