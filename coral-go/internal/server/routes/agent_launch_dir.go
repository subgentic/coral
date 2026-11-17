package routes

import (
	"log/slog"
	"net/http"
	"path/filepath"

	"github.com/subgentic/coral/internal/safefs"
)

// An agent starts agents in the team's folder or below it (#13891, Security's MUST 3): a launch by an agent's verified session seated on a team whose grant is ON, wherever it places the agent, is refused when its working_dir is outside every folder
// the caller's team works in. The folders are the launching session's own and those of the sessions on the board it launches onto, with the repo and the worktree folder of each (a helper in a sibling worktree of
// the team's repo is the team's), resolved with symlinks (safefs.Within), so a link out of the team's folder does not count. A board with no grant row or a grant that is off keeps what it had: an agent starts
// agents anywhere there (Orchestrator's decision on the upgrade risk: nothing on an existing team changes without its owner). The Operator, the dashboard and the command line pick any folder, as before. A board on another computer is that computer's to judge, and a launch that names no board is unchanged.
func (h *SessionsHandler) refuseAgentLaunchOutsideTeam(w http.ResponseWriter, r *http.Request, dir string) bool {
	owner, ok := VerifiedSession(r.Context())
	if !ok || h.ss == nil || h.bs == nil {
		return false
	}
	ctx := r.Context()
	boardName := h.callersBoardWithGrant(r) // the caller's team, when its grant is on: any other caller, or a team with no grant or an off one, is as it was
	if boardName == "" {
		return false
	}
	var roots []string
	add := func(dirs ...*string) {
		for _, d := range dirs {
			if d != nil && *d != "" {
				roots = append(roots, *d)
			}
		}
	}
	if sess, err := h.ss.GetLiveSession(ctx, owner.SessionID); err == nil && sess != nil {
		add(&sess.WorkingDir, sess.WorktreePath, sess.WorktreeRepo)
	}
	if rows, err := h.ss.GetBoardSessions(ctx, boardName); err == nil {
		for _, s := range rows {
			add(&s.WorkingDir, s.WorktreePath, s.WorktreeRepo)
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

// callersBoardWithGrant is the board an agent's launch that named none goes onto (#13903): the board the calling agent is seated on, when the Operator's grant of that board is on. "" for anyone else: the
// Operator, a caller with no session, a session on no board, a board with no grant row or an off grant.
func (h *SessionsHandler) callersBoardWithGrant(r *http.Request) string {
	owner, ok := VerifiedSession(r.Context())
	if !ok || h.ss == nil || h.bs == nil {
		return ""
	}
	sess, err := h.ss.GetLiveSession(r.Context(), owner.SessionID)
	if err != nil || sess == nil || sess.BoardName == nil || *sess.BoardName == "" {
		return ""
	}
	g, err := h.bs.GetOrchGrant(r.Context(), *sess.BoardName)
	if err != nil {
		slog.Warn("an agent's launch with no board was not put on its team: the board's grant could not be read", "board", *sess.BoardName, "error", err)
		return ""
	}
	if !g.Enabled {
		return ""
	}
	return *sess.BoardName
}

// refuseAgentLaunchWhileAccessOff answers 403 orchestrator_access_off, and reports true, when an agent starts agents on a team whose Orchestrator access the Operator has not switched ON (#17661, #19138): the prompt tells the
// Orchestrator it may not, and this is what backs that up. It is the same rule wake and restart apply (orchestrator_agents.go): access must be explicitly on, so a board with no grant row is as off as one the Operator switched off
// (GetOrchGrant: "a board that has none has the switch off"). It is the caller's own team (the board its session is seated on) and the board the launch names, whichever is not on (a board this launch made is not counted: it has no switch to be off). The Operator's and the dashboard's launches are never
// held, an agent with no board and naming none has no team switch to hold it, and a team with the access on is held to its caps and folders as before. An unreadable grant refuses too: access that cannot be shown on is not on.
func (h *SessionsHandler) refuseAgentLaunchWhileAccessOff(w http.ResponseWriter, r *http.Request, named, boardServer string, madeBoard bool) bool {
	owner, ok := VerifiedSession(r.Context())
	if !ok || h.ss == nil || h.bs == nil {
		return false
	}
	boards := []string{named}
	if madeBoard || (boardServer != "" && boardServer != "local") {
		boards = nil // a team this launch made has no switch yet, and a board on another computer is that Coral's to decide: the caller's own team, below, still holds the launch
	}
	if sess, err := h.ss.GetLiveSession(r.Context(), owner.SessionID); err == nil && sess != nil && sess.BoardName != nil {
		boards = append(boards, *sess.BoardName)
	}
	for _, b := range boards {
		if b == "" {
			continue
		}
		g, err := h.bs.GetOrchGrant(r.Context(), b)
		if err == nil && g.Enabled {
			continue
		}
		if err != nil {
			slog.Warn("an agent's launch was refused: the team's Orchestrator access could not be read", "board", b, "error", err)
		}
		msg := "the Operator has not allowed agents to start agents on team " + b + ": ask the Operator to turn on Orchestrator access in the team's settings (Team settings > Orchestrator access: pick the seat and the caps)"
		writeError(w, http.StatusForbidden, "orchestrator_access_off", msg)
		return true
	}
	return false
}
