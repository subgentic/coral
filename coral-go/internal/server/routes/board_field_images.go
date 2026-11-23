package routes

import (
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/httputil"
)

// Pictures for the prose fields of a task, the board chat and instructions (#20731, goal #285): POST /api/board/{project}/field-images?scope=task|chat|instruction[&draft=<id>] stores one picture as an artifact of
// that team before the record it belongs to is written, and POST /api/field-images?scope=instruction does the same for a person-level field that has no team (global prompts, reminders, scheduled jobs, notes).
// The Operator's alone, as goal-images is (operatorOnly: this computer's person, or the owner through Coral Hub); the file is checked as a comment's picture is (receivePicture) and the reply names it by hash
// and uri. Goal-images stays what it is: its recent-upload scope is goal-specific. The writes that name these pictures (images on a task, a message, an instruction) are separate slices.
const sourceFieldImagePrefix = "field-image:"

// fieldImageScopes are the fields a picture can be uploaded for.
var fieldImageScopes = map[string]bool{"task": true, "chat": true, "instruction": true}

var fieldDraftRe = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// fieldImageScope is what a just-uploaded field picture is remembered under: the team ("" for a person's own), the field and the draft it was uploaded for.
func fieldImageScope(project, scope, draft string) string {
	return "field:" + project + ":" + scope + ":" + draft
}

// fieldImageRequest reads and checks ?scope and ?draft; it answers the request itself when they are not allowed.
func fieldImageRequest(w http.ResponseWriter, r *http.Request) (scope, draft string, ok bool) {
	scope = strings.TrimSpace(r.URL.Query().Get("scope"))
	if !fieldImageScopes[scope] {
		errBadRequest(w, "scope must be task, chat or instruction")
		return "", "", false
	}
	draft = strings.TrimSpace(r.URL.Query().Get("draft"))
	if draft != "" && !fieldDraftRe.MatchString(draft) {
		errBadRequest(w, "draft must be 1 to 64 characters of a-z, 0-9 and -")
		return "", "", false
	}
	return scope, draft, true
}

// UploadFieldImage stores one picture for a field of a team's record.
func (h *BoardHandler) UploadFieldImage(w http.ResponseWriter, r *http.Request) {
	if !operatorOnly(w, r) {
		return
	}
	project := urlParam(r, "project")
	scope, draft, ok := fieldImageRequest(w, r)
	if !ok {
		return
	}
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
		session = personPictureSession // a team with no agent: the picture is the person's own (#12176)
	}
	h.storeFieldImage(w, r, project, scope, draft, session)
}

// UploadPersonFieldImage stores one picture for a person-level field, which belongs to no team.
func (h *BoardHandler) UploadPersonFieldImage(w http.ResponseWriter, r *http.Request) {
	if !operatorOnly(w, r) {
		return
	}
	scope, draft, ok := fieldImageRequest(w, r)
	if !ok {
		return
	}
	if scope != "instruction" {
		errBadRequest(w, "a picture with no team can only be for an instruction")
		return
	}
	if h.coralDir == "" {
		errInternalServer(w, "no data folder")
		return
	}
	h.storeFieldImage(w, r, "", scope, draft, personPictureSession)
}

func (h *BoardHandler) storeFieldImage(w http.ResponseWriter, r *http.Request, project, scope, draft, session string) {
	key := fieldImageScope(project, scope, draft)
	if !commentImageLimit.allow(fieldImageRateKey(project, scope), commentImageLimitPerMinute, time.Now()) { // the team and the field, not the draft: a new draft id is no new allowance
		httputil.WriteActionLimit(w, 60, "rate_limited", "too many pictures in a minute; try again shortly")
		return
	}
	pic, ok := receivePicture(w, r, h.coralDir)
	if !ok {
		return
	}
	defer os.Remove(pic.tmpPath) // a no-op once it is in the store
	reply, ok := storeReceivedPicture(w, h.coralDir, session, pic, nil, sourceFieldImagePrefix+scope)
	if !ok {
		return
	}
	rememberFieldImage(key, pic.hexID, time.Now()) // named by a write for the next 24 h (fieldImageTTL)
	reply["source"], reply["scope"], reply["draft"] = sourceFieldImagePrefix+scope, scope, draft
	writeJSON(w, http.StatusCreated, reply)
}
