package routes

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/branches"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/store"
)

// The Branches tab (goal #11): the worktrees of the repository an agent works in, from the git poller's snapshot (internal/branches). Read-only: no git runs for a request, and there is
// no route that changes anything. The same access as GET .../git: a bounded caller (the Hub, a page that is not this computer's own dashboard) reads only the session its session_id
// names, and gets no agents of other worktrees (they may be of another team); no folder path is served.

// BranchesSource is the snapshot of the repositories the live agents work in.
type BranchesSource interface {
	For(dir string) (branches.Repo, int, bool)
	Holds(repo branches.Repo, i int, dir string) bool
	Detail(ctx context.Context, repo branches.Repo, head string) (branches.Detail, bool, error) // a branch's commits and files over the base (#17543): read when a row is opened
	Same(a, b branches.Repo) bool                                                               // the same repository (the team view groups by it)
	ReadState(dir string) (state string, notGit bool) // pending until the folder is read, done after; notGit when it holds no repository (#17058, #17600)
}

// SetBranches wires the snapshot in.
func (h *SessionsHandler) SetBranches(src BranchesSource) { h.branches = src }

// branchAgent is an agent shown on a worktree's card.
type branchAgent struct {
	Name      string `json:"name"`
	SessionID string `json:"session_id"`
	AgentType string `json:"agent_type"`
}

// branchAgentName is how the agent is called on screen: its display name (Developer 2) when it has one, else its name, which for a plain agent is its folder (#17543).
func branchAgentName(ls store.LiveSession) string {
	if ls.DisplayName != nil && strings.TrimSpace(*ls.DisplayName) != "" {
		return *ls.DisplayName
	}
	return ls.AgentName
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

// folderReadState is the one meaning of read_state and not_git for a folder with no repository picture yet (#17058, #17483, #17600): not_git is true when no git repository is there, whether the collector read
// the folder and found none or the file system shows no .git in it or above it (said at once, not after a minute of "reading"); a folder with no .git marker is then "done", not "pending".
func (h *SessionsHandler) folderReadState(dir string) (state string, notGit bool) {
	state, notGit = h.branches.ReadState(dir)
	if !notGit && gitutil.NoRepoMarkerFor(dir) {
		return "done", true
	}
	return state, notGit
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
		rs, ng := "pending", false
		if dir != "" {
			rs, ng = h.folderReadState(dir)
		}
		writeJSON(w, http.StatusOK, map[string]any{"available": true, "found": false, "read_state": rs, "not_git": ng})
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
						rows[i].Agents = append(rows[i].Agents, branchAgent{Name: branchAgentName(ls), SessionID: ls.SessionID, AgentType: ls.AgentType})
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
		ask  *branchAgent // an agent of the team in this repository, through whom a row's detail is asked for (#17543)
	}
	var sections []*section
	readState := "done"
	anyDir := false
	allNotGit := true
	for _, ls := range lives {
		if ls.IsArchived == 1 || ls.WorkingDir == "" || ls.BoardName == nil || *ls.BoardName != project {
			continue
		}
		anyDir = true
		repo, own, ok := h.branches.For(ls.WorkingDir)
		if !ok || own < 0 {
			st, ng := h.folderReadState(ls.WorkingDir)
			if st == "pending" {
				readState = "pending"
			}
			if !ng {
				allNotGit = false
			}
			continue
		}
		allNotGit = false
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
		if sec.ask == nil {
			sec.ask = &branchAgent{Name: ls.AgentName, SessionID: ls.SessionID, AgentType: ls.AgentType}
		}
		if own < len(sec.rows) {
			sec.rows[own].Agents = append(sec.rows[own].Agents, branchAgent{Name: branchAgentName(ls), SessionID: ls.SessionID, AgentType: ls.AgentType})
		}
	}
	out := make([]map[string]any, 0, len(sections))
	for _, s := range sections {
		out = append(out, map[string]any{"base": s.repo.Base, "more": s.repo.More, "unreadable": s.repo.Unreadable, "remote": s.repo.Remote, "remote_unknown": s.repo.RemoteUnknown,
			"pr_note": s.repo.PRNote, "at": s.repo.At.UTC().Format(time.RFC3339), "worktrees": s.rows, "ask": s.ask})
	}
	notGit := anyDir && allNotGit && readState == "done"
	writeJSON(w, http.StatusOK, map[string]any{"available": true, "repos": out, "read_state": readState, "not_git": notGit})
}

// BranchDetail answers GET /api/sessions/live/{name}/branches/detail?session_id=&agent_type=&head=: the commits a branch of the agent's repository has over the base and the files they change
// (#17543). The same access as Branches; head must be the head of a worktree of that repository (anything else is 404), and the range is made of commit ids Coral read itself.
func (h *SessionsHandler) BranchDetail(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	sessionID := r.URL.Query().Get("session_id")
	agentType := r.URL.Query().Get("agent_type")
	if !h.requireAgentSession(w, r, name, sessionID) {
		return
	}
	if owner, isAgent := VerifiedSession(r.Context()); isAgent && !h.agentMayReadAgent(r, owner.SessionID, sessionID) {
		errForbidden(w, "an agent reads the branches of its own team's agents only")
		return
	}
	if h.branches == nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	repo, _, ok := h.branches.For(h.resolveWorkdir(agentCtx(r), name, agentType, sessionID))
	if !ok {
		errNotFound(w, "No repository has been read for this agent's folder yet.")
		return
	}
	d, found, err := h.branches.Detail(r.Context(), repo, r.URL.Query().Get("head"))
	if !found {
		errNotFound(w, "That branch is not in this repository's last read.")
		return
	}
	if err != nil {
		errInternalServer(w, "Could not read this branch's commits.")
		return
	}
	writeJSON(w, http.StatusOK, d)
}
