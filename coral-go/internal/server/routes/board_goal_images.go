package routes

import (
	"net/http"
	"os"
	"sort"
	"time"

	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/safefs"
)

// Pictures for a goal's description (#11650, goal #184): POST /api/board/{project}/goal-images stores one picture as an artifact of that team before the goal exists, so the New goal form can show it and the create names
// it in "images". The Operator's alone (operatorOnly: this computer's person, or the owner through Coral Hub; an agent token is refused first). The file is checked as a comment's picture is (receivePicture: its own
// bytes decide the type, metadata is removed, 25 MB), and the create accepts only pictures uploaded for that team a moment ago (goalImageScope).
const sourceGoalImage = "goal-image"

// goalImageScope is what the Operator's just-uploaded goal pictures are remembered under, by team.
func goalImageScope(project string) string { return "goal:" + project }

// teamPictureSession is a session of the team to keep a goal's picture with: the lowest-numbered of its agents' sessions, so the picture is listed in the team's Artifacts and an agent of the team can read it.
func (h *BoardHandler) teamPictureSession(r *http.Request, project string) (string, bool) {
	sessions, err := h.bs.TeamSubscriberSessions(r.Context(), project)
	if err != nil {
		return "", false
	}
	var ids []string
	for _, sid := range sessions {
		if safefs.IsSafeID(sid) && sessionIDLike.MatchString(sid) {
			ids = append(ids, sid)
		}
	}
	if len(ids) == 0 {
		return "", false
	}
	sort.Strings(ids)
	return ids[0], true
}

// UploadGoalImage stores one picture for a new goal's description.
func (h *BoardHandler) UploadGoalImage(w http.ResponseWriter, r *http.Request) {
	if !operatorOnly(w, r) {
		return
	}
	project := urlParam(r, "project")
	if h.coralDir == "" {
		errInternalServer(w, "no data folder")
		return
	}
	if exists, err := h.bs.BoardExists(r.Context(), project); err != nil || !exists {
		errNotFound(w, "this team does not exist")
		return
	}
	session, ok := h.teamPictureSession(r, project)
	if !ok {
		commentRefuse(w, http.StatusConflict, "no_team", "this team has no agent to keep a picture with: add one first")
		return
	}
	if !commentImageLimit.allow(goalImageScope(project), commentImageLimitPerMinute, time.Now()) {
		httputil.WriteActionLimit(w, 60, "rate_limited", "too many pictures in a minute; try again shortly")
		return
	}
	pic, ok := receivePicture(w, r, h.coralDir)
	if !ok {
		return
	}
	defer os.Remove(pic.tmpPath) // a no-op once it is in the store
	reply, ok := storeReceivedPicture(w, h.coralDir, session, pic, nil, sourceGoalImage)
	if !ok {
		return
	}
	rememberCommentImage(goalImageScope(project), pic.hexID, time.Now())
	writeJSON(w, http.StatusCreated, reply)
}
