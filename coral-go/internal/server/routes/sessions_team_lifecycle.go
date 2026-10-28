package routes

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/subgentic/coral/internal/coralnames"
	"github.com/subgentic/coral/internal/logsafe"
	"log"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/gitutil"
)

// KillTeam kills all agents in a team, atomically marking active members as stopped.
// POST /api/sessions/live/team/{boardName}/kill
func (h *SessionsHandler) KillTeam(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	boardName := urlParam(r, "boardName")
	ctx := r.Context()
	bgCtx := context.Background()

	// Get all sessions on this board
	sessions, err := h.ss.GetBoardSessions(ctx, boardName)
	if err != nil {
		errInternalServer(w, "failed to get board sessions: "+err.Error())
		return
	}

	// Atomically stop the team record (snapshots active members with same stopped_at)
	teamWorktree, teamRepo := "", ""
	if h.teamStore != nil {
		if team, err := h.teamStore.GetTeam(ctx, boardName); err == nil && team != nil {
			h.teamStore.StopTeam(ctx, team.ID)
			if team.IsWorktree == 1 && team.WorkingDir != "" {
				teamWorktree = team.WorkingDir
				var cfg struct {
					WorkingDir string `json:"working_dir"`
				}
				json.Unmarshal([]byte(team.ConfigJSON), &cfg)
				teamRepo = cfg.WorkingDir
			}
		}
	}

	// Kill each session
	killed := 0
	for _, ls := range sessions {
		if ls.AgentType != at.Terminal {
			artifactCtx, cancel := context.WithTimeout(bgCtx, 30*time.Second)
			if _, err := h.persistSessionChanges(artifactCtx, ls.SessionID, ls.WorkingDir); err != nil && !errors.Is(err, errNoGitCheckout) {
				slog.Warn("persist team session changes artifact failed", "session_id", ls.SessionID, "error", err)
			}
			cancel()
		}
		h.chatMeta.forget(ls.SessionID)
		h.ss.UnregisterLiveSession(bgCtx, ls.SessionID)
		h.terminal.KillSession(ctx, ls.AgentName, ls.AgentType, ls.SessionID)
		removeBoardStateFile(ls.AgentName, h.cfg)
		agent.CleanupTempFiles(ls.SessionID)
		killed++
	}

	// Artifact snapshots above have finished: the owned worktree goes only if nothing in it is unsaved, and the answer says what was kept and why (#6701).
	resp := map[string]any{"ok": true, "sessions_killed": killed}
	if teamWorktree != "" {
		resp["worktree"] = h.removeOwnedWorktree(bgCtx, "kill-team", teamRepo, teamWorktree, coralnames.TeamBranch(filepath.Base(teamWorktree)))
	}

	// Unpause board
	if h.boardHandler != nil {
		h.boardHandler.SetPaused(boardName, false)
	}

	writeJSON(w, http.StatusOK, resp)
}

// teamBranchOf is the branch a team's worktree is on when path is one Coral made for a team (a folder directly in its worktrees folder), else "": the single kill of the last agent in
// it takes the branch with the worktree when nothing is on it, as a team stop does (QA's #6722).
func (h *SessionsHandler) teamBranchOf(path string) string {
	if !coralnames.InWorktreesRoot(h.cfg.CoralDir(), path) {
		return ""
	}
	return coralnames.TeamBranch(filepath.Base(path))
}

// removeOwnedWorktree takes a stopped agent's or team's worktree away when nothing in it is unsaved and answers what happened ({state, path, branch, reason}): the worktree and its work are never deleted
// without asking (#6701). Git runs in the owning repository, bounded at 30 s.
func (h *SessionsHandler) removeOwnedWorktree(ctx context.Context, who, repo, path, branch string) gitutil.WorktreeOutcome {
	wtCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	outcome, err := gitutil.RemoveWorktree(wtCtx, repo, path, branch)
	if err != nil {
		outcome.State, outcome.Reason = "failed", "git could not find its repository"
		log.Printf("[%s] failed to remove worktree %s: %s", who, logsafe.Dir(path), err)
	} else {
		log.Printf("[%s] worktree %s: %s %s", who, logsafe.Dir(path), outcome.State, outcome.Reason)
	}
	return outcome
}

// ResurrectTeam relaunches a stopped team with only the agents that were active at kill time.
// POST /api/teams/detail/{name}/resurrect
func (h *SessionsHandler) ResurrectTeam(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if name == "" {
		errBadRequest(w, "team name required")
		return
	}
	if h.teamStore == nil {
		errInternalServer(w, "team persistence not available")
		return
	}

	ctx := r.Context()
	team, err := h.teamStore.GetTeam(ctx, name)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if team == nil {
		errNotFound(w, "team not found")
		return
	}
	if team.Status != "stopped" {
		errBadRequest(w, "can only resurrect stopped teams (current status: "+team.Status+")")
		return
	}

	// Get members whose stopped_at matches the team's — these were active at kill time
	members, err := h.teamStore.GetMembersForResurrect(ctx, team.ID)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if len(members) == 0 {
		errBadRequest(w, "no members eligible for resurrection")
		return
	}

	// The team record stays "stopped" until its members are launched, so the kept-worktrees list is told the resurrect is under way: a clean worktree it has just recreated must not be removed before the first
	// member registers (#6959).
	resurrectLock := teamLock(team.ID) // Remove of this team's worktree and this resurrect do not interleave (#6977)
	resurrectLock.Lock()
	defer resurrectLock.Unlock()
	if fresh, ferr := h.teamStore.GetTeamByID(ctx, team.ID); ferr != nil || fresh == nil || fresh.Status != "stopped" { // checked again under the lock: a resurrect that ran while this one waited has relaunched the members (#6977)
		errBadRequest(w, "can only resurrect stopped teams (it is being or has been resurrected)")
		return
	}
	defer beginTeamResurrect(team.ID)()

	// Recreate worktree if team had one
	workingDir := team.WorkingDir
	resurrectRepo := "" // the repository of the team's worktree, for its members' rows
	if team.IsWorktree == 1 {
		// Parse base_branch from stored config
		var cfg struct {
			BaseBranch string `json:"base_branch"`
			WorkingDir string `json:"working_dir"`
		}
		json.Unmarshal([]byte(team.ConfigJSON), &cfg)
		repoDir := cfg.WorkingDir
		if repoDir == "" {
			repoDir = filepath.Dir(team.WorkingDir)
		}
		branch, err := gitutil.ResolveBase(ctx, repoDir, cfg.BaseBranch) // the stored base, else the repository's current branch (#6701)
		if err != nil {
			errBadRequest(w, "failed to recreate worktree: "+err.Error())
			return
		}
		resurrectRepo = repoDir
		if err := gitutil.ValidRef(branch); err != nil { // a stored config is checked again (#3601, W24)
			errBadRequest(w, "the team's base_branch: "+err.Error())
			return
		}

		if !coralnames.InWorktreesRoot(h.cfg.CoralDir(), team.WorkingDir) { // a stored folder is checked again: only Coral's own worktrees folder
			errBadRequest(w, "failed to recreate worktree: the team's folder is not in Coral's worktrees folder")
			return
		}
		// On the team's own branch (coral-team/<board slug>, as the launch made it), not on the base branch itself: that one is checked out in the repository (#6701).
		if _, err := gitutil.AddTeamWorktree(ctx, repoDir, team.WorkingDir, coralnames.TeamBranch(filepath.Base(team.WorkingDir)), branch); err != nil {
			errBadRequest(w, "failed to recreate worktree: "+err.Error())
			return
		}
		log.Printf("[resurrect] recreated worktree at %s (branch %s)", logsafe.Dir(team.WorkingDir), branch)
		if afterResurrectWorktreeHook != nil {
			afterResurrectWorktreeHook()
		}
	}

	// Relaunch each member
	var launched []map[string]any
	for _, m := range members {
		var agentCfg struct {
			Name         string                 `json:"name"`
			Prompt       string                 `json:"prompt"`
			Capabilities *agent.Capabilities    `json:"capabilities"`
			AgentType    string                 `json:"agent_type"`
			Model        string                 `json:"model"`
			Tools        []string               `json:"tools"`
			Hooks        map[string]interface{} `json:"hooks"`
			// The mode the member started in (#10430) and the flags of its own: a member comes back as it was, never in the saved default (#10380)
			PermissionMode string   `json:"permission_mode"`
			Flags          []string `json:"flags"`
		}
		if err := json.Unmarshal([]byte(m.AgentConfigJSON), &agentCfg); err != nil {
			log.Printf("[resurrect] failed to parse agent config for %s: %v", m.AgentName, err)
			launched = append(launched, map[string]any{"name": m.AgentName, "error": "invalid agent config"})
			continue
		}

		agentType := agentCfg.AgentType
		if agentType == "" {
			agentType = "claude"
		}

		// Inject distilled knowledge if available
		resurrectPrompt := InjectKnowledgeIntoPrompt(h.cfg.CoralDir(), team.Name, m.AgentName, agentCfg.Prompt)

		if agentCfg.PermissionMode != "" && !agent.ValidPermissionMode(agentCfg.PermissionMode) {
			log.Printf("[resurrect] corrupt stored permission mode for %s: %s", m.AgentName, agentCfg.PermissionMode)
			launched = append(launched, map[string]any{"name": m.AgentName, "error": "invalid stored permission mode"})
			continue
		}
		memberFlags := resurrectFlags(agentType, agentCfg.PermissionMode, agentCfg.Flags, agentCfg.Capabilities)
		result, err := h.launchSession(ctx, launchSpec{
			WorkDir: workingDir, AgentType: agentType, DisplayName: m.AgentName, Prompt: resurrectPrompt, BoardName: team.Name,
			Model: agentCfg.Model, Capabilities: agentCfg.Capabilities, Tools: agentCfg.Tools, Hooks: agentCfg.Hooks,
			Flags: memberFlags, PermissionMode: agentCfg.PermissionMode,
		})
		if err != nil {
			log.Printf("[resurrect] failed to launch %s: %v", m.AgentName, err)
			launched = append(launched, map[string]any{"name": m.AgentName, "error": err.Error()})
			continue
		}

		sessionID := result["session_id"].(string)

		// Update team member: active, new session_id
		h.teamStore.UpdateMemberStatus(ctx, m.ID, "active", &sessionID)
		h.ss.SetTeamID(ctx, sessionID, team.ID)
		if team.IsWorktree == 1 { // a resurrected member is in the team's worktree like a launched one: its row names it, so a stop or a kill finds it (#6817)
			h.ss.UpdateWorktreeInfo(ctx, sessionID, team.WorkingDir, resurrectRepo)
			h.recordWorktreeRow(ctx, sessionID, team.WorkingDir)
		}

		// Setup board subscription
		h.setupBoardAndPrompt(sessionID, result["session_name"].(string),
			agentType, team.Name, launchedName(result, m.AgentName))

		launched = append(launched, map[string]any{
			"name": launchedName(result, m.AgentName), "session_id": sessionID, "session_name": result["session_name"],
		})
	}

	// Update team status to running
	h.teamStore.UpdateTeamStatus(ctx, team.ID, "running")

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"team_id":     team.ID,
		"board":       team.Name,
		"board_id":    team.Name, // as launch-team answers: the board's id (a team is named by it, #6861)
		"board_label": h.boardLabel(team.Name),
		"agents":      launched,
	})
}

// resurrectFlags are a resurrected member's flags: its own, with the mode it started in as the flags of its type (the way a team reset does it): a member with permission flags of its
// own keeps them as they were, and one with capabilities gets the mode as its permission mode only (#10430).
func resurrectFlags(agentType, mode string, own []string, caps *agent.Capabilities) []string {
	flags := stripAgentPermissionFlags(own)
	if caps != nil && !caps.IsEmpty() {
		return flags
	}
	if carried, _ := agent.SplitPermissionFlags(own); len(carried) > 0 {
		return append(flags, carried...)
	}
	if mode != "" && mode != "default" {
		flags = append(flags, agent.PermissionFlagsForAgent(agentType, mode)...)
	}
	return flags
}
