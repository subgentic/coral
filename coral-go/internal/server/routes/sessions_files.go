package routes

import (
	"context"
	"encoding/base64"
	"encoding/json"
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
	out := map[string]any{"agent_name": name}
	if sessionID != "" {
		snapshots, err = h.gs.GetGitSnapshotsForSession(r.Context(), sessionID, limit)
	} else {
		// By name: newest first, with cursor (the last answer's next_cursor), the true total and has_more (#13188). Without a cursor it is the same newest page as always.
		var after *store.GitAfter
		if c := r.URL.Query().Get("cursor"); c != "" {
			pos, ok := decodeGitCursor(c)
			if !ok {
				errBadRequest(w, "invalid cursor")
				return
			}
			after = &pos
		}
		var total int
		snapshots, total, err = h.gs.GetGitSnapshotsPage(r.Context(), name, limit+1, after)
		if err == nil {
			out["total"] = total
			out["has_more"] = false
			if len(snapshots) > limit {
				snapshots = snapshots[:limit]
				out["has_more"] = true
				out["next_cursor"] = encodeGitCursor(snapshots[limit-1].RecordedAt, snapshots[limit-1].ID)
			}
		}
	}
	if err != nil || snapshots == nil {
		snapshots = []store.GitSnapshot{}
	}
	out["snapshots"] = snapshots
	writeJSON(w, http.StatusOK, out)
}

// The git cursor: base64url of {"r": recorded_at, "i": id}, at most 1024 bytes, only a position in an agent's newest-first snapshots.
func encodeGitCursor(recordedAt string, id int64) string {
	raw, _ := json.Marshal(map[string]any{"r": recordedAt, "i": id})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeGitCursor(c string) (store.GitAfter, bool) {
	var p struct {
		R string `json:"r"`
		I int64  `json:"i"`
	}
	if len(c) > 1024 {
		return store.GitAfter{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil || json.Unmarshal(raw, &p) != nil || p.R == "" || p.I <= 0 {
		return store.GitAfter{}, false
	}
	return store.GitAfter{RecordedAt: p.R, ID: p.I}, true
}
