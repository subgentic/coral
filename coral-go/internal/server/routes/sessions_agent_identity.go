// Which agent a file or diff read is about, for a caller whose reads are bounded (#7565, Security's answer to coral-hub on #7564). The folder of an agent was found from its session id when there was
// one and from its NAME when there was not (or the id was stale, or unknown), so a read through the Coral Hub could show another agent's folder under a name that had been reused, or the folder of one
// agent under the name of another. For a bounded caller (strictBounds: the Hub, and any caller that is not the local dashboard) the agent is now the session the session_id names, and only that.

package routes

import (
	"context"
	"net/http"

	"github.com/subgentic/coral/internal/naming"
)

type strictIdentityKey struct{}

// agentCtx is r's context, marked when the caller is bounded: resolveWorkdir then takes the folder from the session's own row and nothing else. Every file and diff handler resolves through it.
func agentCtx(r *http.Request) context.Context {
	if strictBounds(r) {
		return context.WithValue(r.Context(), strictIdentityKey{}, true)
	}
	if followRequested(r) { // the Files panel's own reads follow the agent into the worktree it works in (#11351)
		return context.WithValue(r.Context(), followKey{}, true)
	}
	return r.Context()
}

func strictIdentity(ctx context.Context) bool {
	v, _ := ctx.Value(strictIdentityKey{}).(bool)
	return v
}

// strictSessionWorkdir is the working folder of the session sessionID, or "" when it has none that can be trusted to be the agent called name: no session id, no row for it, or a row whose agent is not the
// one named (by its agent name or its terminal session name). It never reads the git snapshots, which are kept by name and outlive their session.
func (h *SessionsHandler) strictSessionWorkdir(ctx context.Context, name, sessionID string) string {
	if sessionID == "" {
		return ""
	}
	live, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || live == nil {
		return ""
	}
	tmuxName := naming.SessionName(live.AgentType, sessionID)
	if name != live.AgentName && name != tmuxName {
		return ""
	}
	if pane, _ := h.terminal.FindSession(ctx, tmuxName, live.AgentType, sessionID); pane != nil && pane.CurrentPath != "" {
		return pane.CurrentPath
	}
	return live.WorkingDir
}

// requireAgentSession answers 404 "live session not found" and reports false when a bounded caller's read does not name a live session of the agent called name; the handlers call it first, before any
// cache or file is touched, so a miss is the same answer whatever the cause. Anyone else (the local dashboard) keeps the name fallback.
func (h *SessionsHandler) requireAgentSession(w http.ResponseWriter, r *http.Request, name, sessionID string) bool {
	if !strictBounds(r) || h.strictSessionWorkdir(r.Context(), name, sessionID) != "" {
		return true
	}
	errNotFound(w, "live session not found")
	return false
}
