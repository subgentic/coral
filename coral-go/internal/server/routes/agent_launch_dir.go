package routes

import (
	"net/http"
	"path/filepath"

	"github.com/subgentic/coral/internal/safefs"
)

// An agent starts agents in the team's folder or below it (#13891, Security's MUST 3): a launch by an agent's verified session that names a board is refused when its working_dir is outside every folder the
// caller's team works in. The folders are the launching session's own and those of the sessions on the board it launches onto, resolved with symlinks (safefs.Within), so a link out of the team's folder does
// not count. The Operator, the dashboard and the command line pick any folder, as before. A board on another computer is that computer's to judge, and a launch that names no board is unchanged.
func (h *SessionsHandler) refuseAgentLaunchOutsideTeam(w http.ResponseWriter, r *http.Request, boardName, dir string) bool {
	owner, ok := VerifiedSession(r.Context())
	if !ok || boardName == "" || h.ss == nil {
		return false
	}
	ctx := r.Context()
	var roots []string
	if sess, err := h.ss.GetLiveSession(ctx, owner.SessionID); err == nil && sess != nil && sess.WorkingDir != "" {
		roots = append(roots, sess.WorkingDir)
	}
	if rows, err := h.ss.GetBoardSessions(ctx, boardName); err == nil {
		for _, s := range rows {
			if s.WorkingDir != "" {
				roots = append(roots, s.WorkingDir)
			}
		}
	}
	if filepath.IsAbs(dir) {
		for _, root := range roots {
			if _, err := safefs.Within(root, dir); err == nil {
				return false
			}
		}
	}
	msg := "an agent can start agents only in the team's folder or below it; this folder is outside it. The Operator can start agents anywhere"
	writeError(w, http.StatusForbidden, "outside_team_folder", msg)
	return true
}
