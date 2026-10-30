package routes

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/store"
)

// resolveWorkdir determines the working directory for an agent session.
func (h *SessionsHandler) resolveWorkdir(ctx context.Context, name, agentType, sessionID string) string {
	launch := h.launchWorkdir(ctx, name, agentType, sessionID)
	if followOn(ctx) { // a request that asked to follow, and may (followAllowed): the dashboard's own page, or a signed-in page on another address, whose bounds stay strict (#11351)
		if wt, ok := h.activeWorktree(ctx, name, sessionID, launch); ok {
			return wt.Dir
		}
	}
	return launch
}

// launchWorkdir is the folder the agent was launched in: its pane's folder, then its live row's.
func (h *SessionsHandler) launchWorkdir(ctx context.Context, name, agentType, sessionID string) string {
	if strictIdentity(ctx) {
		return h.strictSessionWorkdir(ctx, name, sessionID) // a bounded caller: the session's own folder, never the name or a snapshot (#7565)
	}
	pane, _ := h.terminal.FindSession(ctx, name, agentType, sessionID)
	if pane != nil {
		if pane.CurrentPath != "" {
			return pane.CurrentPath
		}
	}
	if sessionID != "" {
		if live, err := h.ss.GetLiveSession(ctx, sessionID); err == nil && live != nil && live.WorkingDir != "" {
			return live.WorkingDir
		}
		snap, err := h.gs.GetLatestGitStateBySession(ctx, sessionID)
		if err == nil && snap != nil {
			return snap.WorkingDirectory
		}
	}
	snap, err := h.gs.GetLatestGitState(ctx, name)
	if err == nil && snap != nil {
		return snap.WorkingDirectory
	}
	return ""
}

// resolveGitRoot returns the git toplevel for the agent's working directory.
func (h *SessionsHandler) resolveGitRoot(ctx context.Context, name, agentType, sessionID string) string {
	workdir := h.resolveWorkdir(ctx, name, agentType, sessionID)
	if workdir == "" {
		return ""
	}
	return trustedGitRoot(ctx, workdir)
}

// Git returns recent git snapshots for a live agent.
// GET /api/sessions/live/{name}/git
func (h *SessionsHandler) Git(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	sessionID := r.URL.Query().Get("session_id")
	limit := clampLimit(queryInt(r, "limit", 20), 20, 100)
	if !h.requireAgentSession(w, r, name, sessionID) { // a bounded caller's snapshots are its own session's, never the name's (#7584)
		return
	}

	var snapshots []store.GitSnapshot
	var err error
	if sessionID != "" {
		snapshots, err = h.gs.GetGitSnapshotsForSession(r.Context(), sessionID, limit)
	} else {
		snapshots, err = h.gs.GetGitSnapshots(r.Context(), name, limit)
	}
	if err != nil || snapshots == nil {
		snapshots = []store.GitSnapshot{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent_name": name, "snapshots": snapshots})
}
