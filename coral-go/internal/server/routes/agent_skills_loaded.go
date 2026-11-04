package routes

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/store"
)

// AgentLoadedSkills lists the skills an agent has LOADED (#13208, goal #218): the ones it read through the Skills Store's `skills get`, not a scan of any folder. Each has its name, the version it read, when it first and
// last read it, how many times, whether that version is still approved or was removed, and the newest approved version of its name (so the page can say a newer one exists). Names, versions and times only: never a skill's
// text or files, never what the agent said. The Operator's on this computer (never an agent token, never through Coral Hub). It reads the record, not the CLI, so every agent type has the same answer and a sleeping
// agent still has its list.
// GET /api/sessions/live/{name}/skills?session_id=<id>
func (h *SessionsHandler) AgentLoadedSkills(w http.ResponseWriter, r *http.Request) {
	if refuseNonOperator(w, r, "read an agent's loaded skills") {
		return
	}
	name := chi.URLParam(r, "name")
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		_, sessionID = logparse.ParseSessionName(name)
	}
	if sessionID == "" {
		writeSessionIDRequired(w)
		return
	}
	ls, err := h.ss.GetLiveSession(r.Context(), sessionID)
	if err != nil {
		errInternalServer(w, "could not read the session")
		return
	}
	if ls == nil {
		errNotFound(w, "session not found")
		return
	}
	rows, err := h.ss.LoadedSkills(r.Context(), sessionID)
	if err != nil {
		errInternalServer(w, "could not read the loaded skills")
		return
	}
	type loaded struct {
		store.LoadedSkill
		Newer bool `json:"newer_version"`
	}
	out := make([]loaded, 0, len(rows))
	for _, s := range rows {
		out = append(out, loaded{LoadedSkill: s, Newer: s.LatestVersion > s.Version})
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"agent_type": ls.AgentType, "supported": true, "sleeping": ls.IsSleeping != 0, "skills": out})
}
