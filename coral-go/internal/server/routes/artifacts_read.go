// Reading artifacts: opening an object for serving (without following links) and the agent-facing get of an artifact and its metadata. Moved out of artifacts.go (#8314), no code changed.

package routes

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/secfile"
)

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
