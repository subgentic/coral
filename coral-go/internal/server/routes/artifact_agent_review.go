package routes

import (
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/mediatype"
)

// POST /api/agent/artifacts/{id}/review?session_id=... (#20401, the Operator): an agent sends the newest version of one of its team's files for review WITHOUT new bytes (the upload refuses the same bytes:
// "these bytes are the newest version"), when the first upload forgot the tag or the Operator needs to look again. {id} is any version's digest; the newest version of its series is the one sent. The call is
// idempotent: a file already waiting stays as it is; a decided file starts a new round, as the Operator's own "Send for review" does (the decision and its row go, so Needs you shows it as new).
// The caller must be an agent of the team that owns the file, so no agent sends another team's file to the Operator. The body may hold {"question": "one line"}.
func (h *SessionsHandler) reviewAgentArtifact(w http.ResponseWriter, r *http.Request) {
	sid := r.URL.Query().Get("session_id")
	if _, ok := h.agentFromRequest(w, r, &sid, false); !ok {
		return
	}
	if h.bs == nil {
		errInternalServer(w, "the board is not available")
		return
	}
	id := strings.ToLower(chi.URLParam(r, "id"))
	if !objectNameRe.MatchString(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	var body struct {
		Question string `json:"question"`
	}
	_ = decodeJSON(r, &body) // an empty body is fine: no question of its own
	if hasSignInLink(body.Question) {
		writeError(w, http.StatusBadRequest, "sign_in_link", signInLinkRefusal)
		return
	}
	teamBoard, _, _ := uploaderOf(sid)
	if teamBoard == "" {
		writeError(w, http.StatusForbidden, "no_team", "only an agent of the team that owns a file can send it for review")
		return
	}
	coralDir := h.cfg.CoralDir()
	seriesID, _, in := digestSeriesOnBoard(coralDir, id, teamBoard)
	if !in {
		errNotFound(w, "this team has no such file")
		return
	}
	newest := id
	if ms := seriesMembers(coralDir, seriesID); len(ms) > 0 && ms[0].Board == teamBoard {
		newest = ms[len(ms)-1].Digest
	}
	meta, _ := readSidecar(filepath.Join(coralDir, "artifacts", "objects", newest+".json"))
	name := meta.Name
	if meta.Digest != "" && !mediatype.Viewable(meta.MediaType, name) {
		writeError(w, http.StatusBadRequest, "not_viewable", notViewableForReview(name, meta.MediaType))
		return
	}
	ctx := r.Context()
	tags, decided, err := h.bs.StartArtifactReview(ctx, teamBoard, newest, time.Now())
	if err != nil {
		errInternalServer(w, "could not send the file for review")
		return
	}
	if q, ok := board.CleanReviewQuestion(body.Question); ok {
		if _, qerr := h.bs.SetArtifactQuestion(ctx, teamBoard, newest, q, sid, time.Now()); qerr != nil {
			errInternalServer(w, "could not record the question")
			return
		}
	} else if qs, qerr := h.bs.ArtifactQuestions(ctx, teamBoard); qerr == nil && qs[newest].Question == "" {
		if q, ok := board.CleanReviewQuestion("Look at the new version of " + name + "?"); ok {
			_, _ = h.bs.SetArtifactQuestion(ctx, teamBoard, newest, q, sid, time.Now())
		}
	}
	for _, m := range seriesMembers(coralDir, seriesID) { // the older versions' reviews are closed: this one is the pending one, as after an upload
		if m.Digest != newest && m.Board == teamBoard {
			_, _ = h.bs.SupersedeArtifactReview(ctx, teamBoard, m.Digest, time.Now())
		}
	}
	reply := map[string]any{
		"uri":        "coral://artifacts/" + newest,
		"digest":     newest,
		"tags":       tags,
		"for_review": true,
		"inbox":      "In the Operator's Inbox (Needs you) for review.",
	}
	if decided != "" {
		reply["again_after"] = decided
	}
	writeJSON(w, http.StatusOK, reply)
}
