package routes

import (
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/httputil"
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
	if !in { // a file with one version has no series yet: it is the team's when one of its records is
		for _, rr := range recordsOfDigest(coralDir, id) {
			if rr.rec.Board == teamBoard {
				in = true
				break
			}
		}
	}
	if !in { // a file a linked team sent this team is the team's to send for review too (#21811)
		sc, _ := readSidecar(filepath.Join(coralDir, "artifacts", "objects", id+".json"))
		in = adoptReceivedFile(coralDir, teamBoard, sid, id, sc)
	}
	if !in {
		errNotFound(w, "this team has no such file")
		return
	}
	newest := id
	if seriesID != "" {
		if ms := seriesMembers(coralDir, seriesID); len(ms) > 0 && ms[0].Board == teamBoard {
			newest = ms[len(ms)-1].Digest
		}
	}
	if !objectNameRe.MatchString(newest) { // the series index names the newest version: a digest from our own records, checked here before it is a file name
		errNotFound(w, "this team has no such file")
		return
	}
	meta, _ := readSidecar(filepath.Join(coralDir, "artifacts", "objects", newest+".json"))
	name := meta.Name
	if meta.Digest != "" && !mediatype.Viewable(meta.MediaType, name) {
		writeError(w, http.StatusBadRequest, "not_viewable", notViewableForReview(name, meta.MediaType))
		return
	}
	ctx := r.Context()
	// a file the Operator denied does not come back by an agent's call: only a real new version returns it (the Operator's own Send for review is theirs to make)
	if byTag, terr := h.bs.ArtifactTags(ctx, teamBoard); terr == nil && hasTag(byTag[newest], board.ReviewDenied) {
		writeError(w, http.StatusConflict, "denied", "the Operator denied this file: upload a changed version with --new-version-of to ask again")
		return
	}
	if !reviewResendAllowed(teamBoard+"/"+newest, time.Now()) {
		httputil.WriteActionLimit(w, 3600, "resend_limit", "this file was sent for review "+strconv.Itoa(reviewResendsPerHour)+" times in the last hour: the Operator has it; upload a changed version to ask again")
		return
	}
	tags, decided, err := h.bs.StartArtifactReview(ctx, teamBoard, newest, time.Now())
	if errors.Is(err, board.ErrAlreadyDecided) {
		writeError(w, http.StatusConflict, "already_decided", "the Operator already decided on this file: upload a changed version with --new-version-of to ask again")
		return
	}
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
	for _, m := range reviewSeriesMembers(coralDir, seriesID) { // the older versions' reviews are closed: this one is the pending one, as after an upload
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

// An agent may send one file for review a few times an hour, not in a loop: the Operator's Needs you is theirs (#20401, Security).
const reviewResendsPerHour = 5

var (
	reviewResendMu sync.Mutex
	reviewResends  = map[string][]time.Time{}
)

func reviewResendAllowed(key string, now time.Time) bool {
	reviewResendMu.Lock()
	defer reviewResendMu.Unlock()
	kept := reviewResends[key][:0]
	for _, t := range reviewResends[key] {
		if now.Sub(t) < time.Hour {
			kept = append(kept, t)
		}
	}
	if len(kept) >= reviewResendsPerHour {
		reviewResends[key] = kept
		return false
	}
	reviewResends[key] = append(kept, now)
	if len(reviewResends) > 4096 { // bounded: a table of idle files is dropped whole, a cap that forgets is only ever generous
		reviewResends = map[string][]time.Time{key: reviewResends[key]}
	}
	return true
}

func reviewSeriesMembers(coralDir, seriesID string) []seriesMember {
	if seriesID == "" {
		return nil
	}
	return seriesMembers(coralDir, seriesID)
}
