package routes

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/branches"
)

// The Branches tab (goal #11): the worktrees of the repository an agent works in, from the git poller's snapshot (internal/branches). Read-only: no git runs for a request, and there is
// no route that changes anything. The same access as GET .../git: a bounded caller (the Hub, a page that is not this computer's own dashboard) reads only the session its session_id
// names, and gets no agents of other worktrees (they may be of another team); no folder path is served.

// BranchesSource is the snapshot of the repositories the live agents work in.
type BranchesSource interface {
	For(dir string) (branches.Repo, int, bool)
	Holds(repo branches.Repo, i int, dir string) bool
	Same(a, b branches.Repo) bool // the same repository (the team view groups by it)
}

// SetBranches wires the snapshot in.
func (h *SessionsHandler) SetBranches(src BranchesSource) { h.branches = src }

// branchAgent is an agent shown on a worktree's card.
type branchAgent struct {
	Name      string `json:"name"`
	SessionID string `json:"session_id"`
	AgentType string `json:"agent_type"`
}

type branchWorktree struct {
	branches.Worktree
	Current bool          `json:"current"`          // the worktree the asking agent works in
	Agents  []branchAgent `json:"agents,omitempty"` // the live agents working in it (the local dashboard only)
}

// agentMayReadAgent says an agent (its session, caller) may read the agent of session target: itself, or an agent on the same board. Anything that cannot be read says no.
func (h *SessionsHandler) agentMayReadAgent(r *http.Request, caller, target string) bool {
	if caller == "" || target == "" {
		return false
	}
	if caller == target {
		return true
	}
	me, err := h.ss.GetLiveSession(r.Context(), caller)
	if err != nil || me == nil || me.BoardName == nil || *me.BoardName == "" {
		return false
	}
	them, err := h.ss.GetLiveSession(r.Context(), target)
	return err == nil && them != nil && them.BoardName != nil && *them.BoardName == *me.BoardName
}

// Branches answers GET /api/sessions/live/{name}/branches?session_id=&agent_type=
func (h *SessionsHandler) Branches(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	sessionID := r.URL.Query().Get("session_id")
	agentType := r.URL.Query().Get("agent_type")
	if !h.requireAgentSession(w, r, name, sessionID) {
		return
	}
	if owner, isAgent := VerifiedSession(r.Context()); isAgent && !h.agentMayReadAgent(r, owner.SessionID, sessionID) {
		errForbidden(w, "an agent reads the branches of its own team's agents only") // Security's MUST 4: as the roster (agent_roster_scope.go), its own row and its board mates'
		return
	}
	if h.branches == nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	dir := h.resolveWorkdir(agentCtx(r), name, agentType, sessionID)
	repo, own, ok := h.branches.For(dir)
	if dir == "" || !ok {
		writeJSON(w, http.StatusOK, map[string]any{"available": true, "found": false})
		return
	}
	rows := make([]branchWorktree, len(repo.Worktrees))
	for i, wt := range repo.Worktrees {
		rows[i] = branchWorktree{Worktree: wt, Current: i == own}
	}
	if !strictBounds(r) { // the local dashboard sees which agents work where; a bounded caller only its own worktree's numbers
		if lives, err := h.ss.GetAllLiveSessions(r.Context()); err == nil {
			for _, ls := range lives {
				if ls.IsArchived == 1 || ls.WorkingDir == "" {
					continue
				}
				for i := range rows {
					if h.branches.Holds(repo, i, ls.WorkingDir) {
						rows[i].Agents = append(rows[i].Agents, branchAgent{Name: ls.AgentName, SessionID: ls.SessionID, AgentType: ls.AgentType})
						break
					}
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": true, "found": true, "base": repo.Base, "more": repo.More, "unreadable": repo.Unreadable, "remote": repo.Remote, "remote_unknown": repo.RemoteUnknown,
		"pr_note": repo.PRNote, "at": repo.At.UTC().Format(time.RFC3339), "worktrees": rows,
	})
}

// TeamBranches answers GET /api/board/{project}/branches: the repositories the team's live agents work in, one section each, with which of the team's agents work in which worktree.
// The same rules as an agent's tab: no git runs for it, no folder path is served; an agent's token reads only its own team's (the board its own session is on).
func (h *SessionsHandler) TeamBranches(w http.ResponseWriter, r *http.Request) {
	project := chi.URLParam(r, "project")
	if owner, isAgent := VerifiedSession(r.Context()); isAgent {
		me, err := h.ss.GetLiveSession(r.Context(), owner.SessionID)
		if err != nil || me == nil || me.BoardName == nil || *me.BoardName != project {
			errForbidden(w, "an agent reads the branches of its own team only")
			return
		}
	}
	if h.branches == nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	lives, err := h.ss.GetAllLiveSessions(r.Context())
	if err != nil {
		errInternalServer(w, "Could not read the team's agents.")
		return
	}
	type section struct {
		repo branches.Repo
		rows []branchWorktree
	}
	var sections []*section
	for _, ls := range lives {
		if ls.IsArchived == 1 || ls.WorkingDir == "" || ls.BoardName == nil || *ls.BoardName != project {
			continue
		}
		repo, own, ok := h.branches.For(ls.WorkingDir)
		if !ok || own < 0 {
			continue
		}
		var sec *section
		for _, s := range sections {
			if h.branches.Same(s.repo, repo) {
				sec = s
				break
			}
		}
		if sec == nil {
			sec = &section{repo: repo, rows: make([]branchWorktree, len(repo.Worktrees))}
			for i, wt := range repo.Worktrees {
				sec.rows[i] = branchWorktree{Worktree: wt}
			}
			sections = append(sections, sec)
		}
		if own < len(sec.rows) {
			sec.rows[own].Agents = append(sec.rows[own].Agents, branchAgent{Name: ls.AgentName, SessionID: ls.SessionID, AgentType: ls.AgentType})
		}
	}
	out := make([]map[string]any, 0, len(sections))
	for _, s := range sections {
		out = append(out, map[string]any{"base": s.repo.Base, "more": s.repo.More, "unreadable": s.repo.Unreadable, "remote": s.repo.Remote, "remote_unknown": s.repo.RemoteUnknown,
			"pr_note": s.repo.PRNote, "at": s.repo.At.UTC().Format(time.RFC3339), "worktrees": s.rows})
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": true, "repos": out})
}
