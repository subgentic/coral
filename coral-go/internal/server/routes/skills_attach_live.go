package routes

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
)

// The $skill menu of the message box (#12676): the Operator searches the approved skills and attaches one to an agent that is already running, and is given the one line to put in the message. Person only: an agent
// token, a script and Coral Hub all get a 403, and skills never go through the Hub in v1 (Security on #12653).

// maxMenuSkills is how many skills the menu shows.
const maxMenuSkills = 20

// personOnlySkills refuses everyone but the person at this computer's dashboard: the Hub (even a tunneled owner), an agent's token and a script's key.
func personOnlySkills(w http.ResponseWriter, r *http.Request, what string) bool {
	if cloud.Tunneled(r) {
		writeError(w, http.StatusForbidden, "hub_refused", "skills are not offered through Coral Hub")
		return false
	}
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "owner_only", "only the person at this computer can "+what)
		return false
	}
	return true
}

// SearchSkillsMenu: GET /api/skills/search?q=words. The approved skills for the menu, the newest approved version of each name, at most maxMenuSkills; no words lists the newest approved ones.
func (h *SkillsHandler) SearchSkillsMenu(w http.ResponseWriter, r *http.Request) {
	if !personOnlySkills(w, r, "search the skills") {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 500 {
		errBadRequest(w, "the search is too long")
		return
	}
	var rows []store.SkillRow
	if q == "" {
		all, err := h.ss.ListApprovedSkills(r.Context())
		if err != nil {
			errInternalServer(w, "could not list the skills")
			return
		}
		rows = all
	} else {
		hits, err := h.ss.SearchSkills(r.Context(), q, maxMenuSkills)
		if err != nil {
			errInternalServer(w, "could not search the skills")
			return
		}
		for _, x := range hits {
			rows = append(rows, store.SkillRow{ID: x.ID, Name: x.Name, Version: x.Version, Description: x.Description, HasScripts: x.HasScripts, NotReviewable: x.NotReviewable})
		}
	}
	// The menu offers the newest approved version of each name, whichever version the words matched: what is attached is the newest too.
	current := map[string]store.SkillRow{}
	if all, err := h.ss.ListApprovedSkills(r.Context()); err == nil {
		for _, x := range all {
			current[x.Name] = x
		}
	}
	out := make([]skillSummary, 0, len(rows))
	seen := map[string]bool{}
	for _, x := range rows {
		if seen[x.Name] {
			continue
		}
		seen[x.Name] = true
		if c, ok := current[x.Name]; ok {
			x = c
		}
		out = append(out, skillSummary{ID: x.ID, Name: x.Name, Version: x.Version, Description: x.Description, HasScripts: x.HasScripts, NotReviewable: x.NotReviewable})
		if len(out) == maxMenuSkills {
			break
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"skills": out})
}

// skillUseLine is the fixed line the message carries: the skill's name cleaned to one plain line and its id, which is the only thing the agent runs.
func skillUseLine(name, id string) string {
	return "Use the skill " + noteLine(name, 64) + " (coral-agent skills get --id " + id + ")."
}

// AttachSkillToLive: POST /api/sessions/live/{name}/skills?session_id=...  {"skill_id": "..."}. Attaches the approved skill's newest approved version to that running agent, pinned as at a launch (so `coral-agent skills list` shows
// it), once (a second attach is the same row), and answers with the line for the message. A pending, rejected, removed or unknown skill is refused the same way.
func (h *SkillsHandler) AttachSkillToLive(w http.ResponseWriter, r *http.Request) {
	if !personOnlySkills(w, r, "attach a skill to an agent") {
		return
	}
	var body struct {
		SkillID string `json:"skill_id"`
	}
	if err := decodeJSON(r, &body); err != nil || !validSkillID(body.SkillID) {
		errBadRequest(w, "skill_id is the 32-character id of a skill")
		return
	}
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" { // the name of a live agent is "<cli>-<session id>"
		if _, id, found := strings.Cut(chi.URLParam(r, "name"), "-"); found {
			sessionID = id
		}
	}
	live, err := h.ss.GetLiveSession(r.Context(), sessionID)
	if sessionID == "" || err != nil || live == nil || live.IsArchived == 1 {
		errNotFound(w, "agent not found")
		return
	}
	if name := chi.URLParam(r, "name"); !strings.EqualFold(name, live.AgentType+"-"+live.SessionID) { // the name in the path is the agent the session_id belongs to, never another one (Security's SHOULD on #12676)
		errBadRequest(w, "the agent name in the path does not belong to that session_id")
		return
	}
	row, err := h.ss.GetApprovedSkill(r.Context(), body.SkillID)
	if err != nil {
		writeError(w, http.StatusConflict, "skill_not_approved", "that skill is not an approved skill")
		return
	}
	newest := *row // the skill's current approved version: the one the menu offers
	if approved, err := h.ss.ListApprovedSkills(r.Context()); err == nil {
		for _, x := range approved {
			if x.Name == row.Name && x.Version > newest.Version {
				newest = x
			}
		}
	}
	already := false
	if have, err := h.ss.AttachedSkills(r.Context(), live.SessionID); err == nil {
		for _, a := range have {
			if a.SkillID == newest.ID {
				already = true
			}
		}
	}
	if !already {
		if err := h.ss.ReplaceAttachedSkill(r.Context(), live.SessionID, newest); err != nil {
			errInternalServer(w, "could not attach the skill")
			return
		}
		_ = h.ss.LogSkillAccess(r.Context(), "attach", newest.ID, newest.Digest, store.PublisherOperator, "operator", "session="+live.SessionID)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "attached": true, "already": already, "line": skillUseLine(newest.Name, newest.ID),
		"skill": map[string]any{"id": newest.ID, "name": newest.Name, "version": newest.Version}})
}
