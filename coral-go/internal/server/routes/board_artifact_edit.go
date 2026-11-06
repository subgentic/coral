package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
)

// The Markdown editor's save (#13757, #13756): the Operator edits a team's Markdown file in the dashboard and the result is a NEW VERSION of its series, never a change of the old bytes (a digest always
// opens exactly its bytes). Two routes, both the Operator's alone (a person on this computer; through Coral Hub the owner's alone):
//
//	GET  /api/board/{project}/artifacts/{digest}/edit   what the editor needs: whether the file can be edited, its name, the series, the newest version and the size limit
//	POST /api/board/{project}/artifacts/{digest}/edit?expected_latest=<64-hex>   the new text as the body (raw UTF-8, stored exactly as sent); expected_latest is the digest the editor last saw as the newest version. It is in
//	the QUERY, not a header, because the owner stamp (the self-hosted Hub) binds the method, the path and query and the body hash, so the value the person's page chose cannot be changed on the way
//
// {digest} is the version the editor opened; the save is a compare-and-swap on the series' newest version, under the series lock: when someone (an agent's upload, another save) added a version since, nothing
// is written and the answer is 409 with the newest version, so the editor can show it and save again against it. The kind, the series and the team belong to the file, as for an agent's new version.

// maxMarkdownEdit is the largest text one save takes (the editor's own limit; bigger files stay the agents').
const maxMarkdownEdit = 2 << 20

// sourceOperatorEdit is the record's Source for a version the Operator saved from the editor.
const sourceOperatorEdit = "edit"

// The save reads ?expected_latest= (spelled out in the handler: the tunnel's query table is generated from the handlers' own Query().Get calls): the digest the editor believed to be the newest version
// when it opened (or last saved); the save only goes through when it still is.

var editDigestRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// editTarget finds the file an edit is for: the opened version's series members as the records say, and the editable facts of the newest one. ok false: the answer was written (the same words for a file
// that is not there and one that is another team's).
type editTarget struct {
	seriesID string
	latest   seriesMember // the newest version (the opened one itself when it is in no series)
	rec      agentUploadRecord
}

func (h *BoardHandler) editTargetOf(w http.ResponseWriter, project, digest string) (editTarget, bool) {
	var t editTarget
	if !editDigestRe.MatchString(digest) {
		errBadRequest(w, "the artifact is named by its 64-hex digest")
		return t, false
	}
	coralDir := h.coralDir
	if coralDir == "" {
		errInternalServer(w, "no data folder")
		return t, false
	}
	notFound := func() (editTarget, bool) {
		errNotFound(w, "this team has no such file")
		return editTarget{}, false
	}
	if sid, _, in := digestSeries(coralDir, digest); in {
		ms := seriesMembers(coralDir, sid)
		if len(ms) == 0 || ms[0].Board != project {
			return notFound()
		}
		t.seriesID, t.latest = sid, ms[len(ms)-1]
	} else {
		for _, r := range recordsOfDigest(coralDir, digest) {
			if r.rec.Board == project {
				t.latest = memberOf(digest, r.session, r.rec)
				t.latest.N = 1
				break
			}
		}
		if t.latest.Session == "" {
			return notFound()
		}
	}
	rec, ok := readUploadRecord(coralDir, t.latest.Session, t.latest.Digest)
	if !ok {
		return notFound()
	}
	t.rec = rec
	return t, true
}

func isMarkdownRecord(rec agentUploadRecord) bool {
	mt := strings.ToLower(strings.TrimSpace(strings.SplitN(rec.MediaType, ";", 2)[0]))
	if mt == "text/markdown" || mt == "text/x-markdown" {
		return true
	}
	n := strings.ToLower(rec.Name)
	return mt == "text/plain" && (strings.HasSuffix(n, ".md") || strings.HasSuffix(n, ".markdown"))
}

// GetArtifactEdit answers GET /api/board/{project}/artifacts/{digest}/edit: whether the file can be edited and its newest version. It tells no more than the team's artifact list does (names and digests),
// so, like it, any caller refuseNonOwner lets in may read it; only the save is the person's.
func (h *BoardHandler) GetArtifactEdit(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	t, ok := h.editTargetOf(w, urlParam(r, "project"), strings.ToLower(urlParam(r, "digest")))
	if !ok {
		return
	}
	out := map[string]any{"can_edit": isMarkdownRecord(t.rec), "name": t.rec.Name, "media_type": t.rec.MediaType, "latest_digest": t.latest.Digest, "version": t.latest.N, "latest_version": t.latest.N, "max_bytes": maxMarkdownEdit}
	if t.seriesID != "" {
		out["series_id"] = t.seriesID
	}
	if !isMarkdownRecord(t.rec) {
		out["reason"] = "only a Markdown file can be edited here"
	}
	writeJSON(w, http.StatusOK, out)
}

// editOnly is the check both routes begin with: through Coral Hub the account this computer is linked to and nobody else, on this computer a person from this server's own page (an agent's token is
// refused before the handler; a cross-site page cannot send the custom header or this Content-Type).
func editOnly(w http.ResponseWriter, r *http.Request) bool {
	if refuseNonOwner(w, r) {
		return false
	}
	if !humanInputCaller(r) {
		commentRefuse(w, http.StatusForbidden, "owner_only", "only the person at this computer can edit a file")
		return false
	}
	// The browser's own headers (Origin, Referer, Sec-Fetch-Site) say a dashboard fetch comes from this server's page. A Hub does not carry them: the self-hosted Hub's proxy strips the browser's, and the
	// tunnel's request is the connector's. Those two are checked by what they ARE: a genuine owner stamp (the identity layer verified the MAC, the route, the query and the body) or an authentic tunnel
	// request; the check stays for the dashboard's cookie and for no cookie at this computer.
	kind, _ := r.Context().Value(callerKindKey{}).(string)
	hubCaller := kind == callerHubOwner || (kind == callerHub && cloud.TunneledAuthentic(r))
	if r.Method != http.MethodGet && !hubCaller && !sameOriginFetch(r) {
		commentRefuse(w, http.StatusForbidden, "cross_site", "a file is saved from this server's own page")
		return false
	}
	return true
}

// SaveArtifactEdit answers POST /api/board/{project}/artifacts/{digest}/edit.
func (h *BoardHandler) SaveArtifactEdit(w http.ResponseWriter, r *http.Request) {
	if !editOnly(w, r) {
		return
	}
	project := urlParam(r, "project")
	opened := strings.ToLower(urlParam(r, "digest"))
	expected := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("expected_latest")))
	if expected == "" {
		expected = opened
	}
	if !editDigestRe.MatchString(expected) {
		errBadRequest(w, "?expected_latest= is the 64-hex digest of the newest version the editor saw")
		return
	}
	if r.ContentLength > maxMarkdownEdit {
		artifactRefusal(w, http.StatusRequestEntityTooLarge, "artifact_too_large", "", "a file saved from the editor is at most 2 MiB")
		return
	}
	t, ok := h.editTargetOf(w, project, opened)
	if !ok {
		return
	}
	if !isMarkdownRecord(t.rec) {
		writeError(w, http.StatusUnsupportedMediaType, "not_markdown", "only a Markdown file can be edited here")
		return
	}
	// A paused board does not stop the save (the Operator's decision, #13757): a save sends nothing to any agent, so the "nothing reaches a paused board's agents" rule has nothing to hold.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMarkdownEdit+1))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) || len(body) > maxMarkdownEdit {
		artifactRefusal(w, http.StatusRequestEntityTooLarge, "artifact_too_large", "", "a file saved from the editor is at most 2 MiB")
		return
	}
	if err != nil {
		errBadRequest(w, "the save was cut short")
		return
	}
	if len(body) == 0 {
		errBadRequest(w, "the file is empty")
		return
	}
	if !utf8.Valid(body) {
		errBadRequest(w, "the text is not valid UTF-8")
		return
	}
	if refuseIfDiskLow(w) {
		return
	}
	coralDir := h.coralDir
	sum := sha256.Sum256(body)
	hexID := hex.EncodeToString(sum[:])
	dir := filepath.Join(coralDir, "artifacts", "objects")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		errInternalServer(w, "could not store the file")
		return
	}
	tmp, err := os.CreateTemp(dir, artifactUploadTempP+"*")
	if err != nil {
		errInternalServer(w, "could not store the file")
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // a no-op once it is in the store
	_, werr := tmp.Write(body)
	if cerr := tmp.Close(); werr != nil || cerr != nil {
		errInternalServer(w, "could not store the file")
		return
	}

	// The compare-and-swap: planNewVersion takes the series lock and holds it until the version is committed, so two saves, or a save and an agent's new version, are one after the other and the
	// second sees the first.
	plan, perr := planNewVersion(coralDir, "coral://artifacts/"+opened, project, hexID)
	if perr != nil {
		h.answerSeriesRefusal(w, coralDir, hexID, perr)
		return
	}
	defer plan.unlock()
	latest := t.latest
	if len(plan.rows) > 0 {
		latest = plan.rows[len(plan.rows)-1] // read again under the lock: the newest as it is NOW
	}
	if plan.same != nil { // these bytes are already the newest version: nothing is added, and that version is the answer
		writeJSON(w, http.StatusOK, editReply(plan.same.Digest, plan.same.N, plan.id, t.rec.Name, int64(len(body)), false))
		return
	}
	if latest.Digest != expected {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "a newer version of this file was saved since you opened it", "code": "stale_version", "latest_digest": latest.Digest, "latest_version": latest.N, "version": latest.N, "series_id": plan.id,
		})
		return
	}
	// The kind belongs to the series (#12144): the version carries it, and an editor asks for none.
	seriesKind := ""
	if kinds, kerr := h.bs.ArtifactKindsOf(r.Context(), project); kerr == nil {
		for _, m := range plan.rows {
			if k := kinds[m.Digest]; m.Board == project && k != "" {
				seriesKind = k
				break
			}
		}
	}
	kind, _ := seriesKindFor(seriesKind, "")
	base, _ := readUploadRecord(coralDir, latest.Session, latest.Digest)
	mediaType := base.MediaType
	if mediaType == "" {
		mediaType = "text/markdown"
	}
	// The version is stored under the session of the newest one (it is listed with the same agent), but it is the TEAM's and the Operator's: the record names the board, the owner of the file's record and
	// the Operator, whether or not that agent is still running.
	meta, _, serr := storeArtifactFileAs(coralDir, latest.Session, base.Name, mediaType, tmpPath, hexID, int64(len(body)), &plan.stamp, 0, func(rec *agentUploadRecord) {
		rec.Board, rec.OwnerKind, rec.OwnerID = project, base.OwnerKind, base.OwnerID
		rec.Uploader, rec.Role = board.OperatorName, "operator"
		rec.UploadedBy, rec.Source = "owner", sourceOperatorEdit
	})
	if errors.Is(serr, errStoreFull) {
		artifactRefusal(w, http.StatusRequestEntityTooLarge, "artifact_quota", "store", "the artifact store is full: delete old artifacts or raise the limit (Settings > Storage and cleanup)")
		return
	}
	if serr != nil {
		errInternalServer(w, "could not store the file")
		return
	}
	if kind != "" {
		if _, kerr := h.bs.SetArtifactKind(r.Context(), project, hexID, kind, latest.Session, time.Now()); kerr != nil {
			slog.Warn("[artifact edit] the kind of an edited version was not recorded", "digest", hexID, "error", kerr)
		}
	}
	versions, cerr := plan.commit(coralDir, hexID, latest.Session)
	if cerr != nil {
		slog.Warn("[artifact edit] an edited version was stored but its series could not be recorded", "series", plan.id, "error", cerr)
		errInternalServer(w, "the file was stored but its series could not be recorded")
		return
	}
	h.bs.NoteArtifactsChanged(project)
	noteArtifactsChanged()
	h.forgetTaskCounts()
	noteActivity(r, board.ActFileEdit, "file", hexID, project, meta.Name, "")
	reply := editReply(hexID, plan.stamp.Version, plan.id, meta.Name, meta.Size, true)
	reply["versions"] = versions
	writeJSON(w, http.StatusCreated, reply)
}

func editReply(digest string, version int, series, name string, size int64, created bool) map[string]any {
	return map[string]any{"digest": "sha256:" + digest, "id": digest, "uri": "coral://artifacts/" + digest, "version": version, "series_id": series, "name": name, "size": size, "created": created}
}

// answerSeriesRefusal writes a refused version's answer in the same words as an agent's upload (the answer needs no handler state).
func (h *BoardHandler) answerSeriesRefusal(w http.ResponseWriter, coralDir, hexID string, err error) {
	(&SessionsHandler{}).answerSeriesRefusal(w, coralDir, hexID, err)
}
