package routes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/coralnames"
	"github.com/subgentic/coral/internal/store"
)

// SetTeamHomeFolder changes the folder a team's agents start in: launch, wake, resurrect and a restart. A running agent stays where it is and
// starts in the new folder the next time it starts (#10815). The Operator's: an agent's token and Coral Hub cannot (identity_routes.go).
// PUT /api/teams/detail/{name}/home-folder {"working_dir": "/absolute/folder"}
func (h *SessionsHandler) SetTeamHomeFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkingDir string `json:"working_dir"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	team, err := h.teamStore.GetTeam(r.Context(), chi.URLParam(r, "name"))
	if err != nil || team == nil {
		errNotFound(w, "team not found")
		return
	}
	dir, msg := validTeamHomeFolder(h.cfg.CoralDir(), team, body.WorkingDir)
	if msg != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg, "field": "working_dir"})
		return
	}
	if err := h.teamStore.UpdateTeamWorkingDir(r.Context(), team.ID, dir); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "working_dir": dir, "applies": "next start"})
}

// validTeamHomeFolder is the cleaned folder, or the words that say why it is refused: it is absolute, exists and is a directory; a worktree team's
// folder stays inside Coral's worktrees folder, as resurrect checks (#10815).
func validTeamHomeFolder(coralDir string, team *store.Team, dir string) (string, string) {
	if dir == "" || !filepath.IsAbs(dir) {
		return "", "The folder must be an absolute path."
	}
	dir = filepath.Clean(dir)
	info, err := os.Stat(dir)
	if err != nil {
		return "", "That folder does not exist."
	}
	if !info.IsDir() {
		return "", "That path is not a folder."
	}
	if team.IsWorktree == 1 && !coralnames.InWorktreesRoot(coralDir, dir) {
		return "", "This team works in a worktree: its folder must be inside Coral's worktrees folder."
	}
	return dir, ""
}

// teamHomeFolder is the folder the team of a session says its agents start in, or "" when the session is on no team, the team has none, or the folder
// is gone (the session then keeps its own: a missing folder never stops a wake). A team is found by the row's team id, else by its member row.
func (h *SessionsHandler) teamHomeFolder(ctx context.Context, ls *store.LiveSession) string {
	if ls == nil || h.teamStore == nil {
		return ""
	}
	var team *store.Team
	if ls.TeamID != nil {
		team, _ = h.teamStore.GetTeamByID(ctx, *ls.TeamID)
	}
	if team == nil {
		if m, _ := h.teamStore.GetMemberBySessionID(ctx, ls.SessionID); m != nil {
			team, _ = h.teamStore.GetTeamByID(ctx, m.TeamID)
		}
	}
	if team == nil || team.WorkingDir == "" {
		return ""
	}
	if info, err := os.Stat(team.WorkingDir); err != nil || !info.IsDir() {
		return ""
	}
	return team.WorkingDir
}
