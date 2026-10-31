package routes

import (
	"context"
	"encoding/json"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
	"strings"
	"time"
)

// Codex 0.163.0 emits identical PermissionRequest hook inputs for automatic
// review and a human approval. Its turn_context identifies the reviewer, but
// there is no second permission/escalation hook. Its OSC 7501 blocked signal
// identifies the human wait. If unavailable, confirm a live menu; never promote a slow automatic review.
// The hook's sanitized event stays in memory until confirmation, not the feed.
type codexPermissionWatch struct{ wake chan struct{} }

func (h *SessionsHandler) watchCodexPermission(name, workingDir string, event *store.AgentEvent) {
	if event.SessionID == nil || event.ToolName == nil {
		return
	}
	sid, tool := *event.SessionID, *event.ToolName
	var detail struct {
		CallIDs []string `json:"call_ids"`
	}
	if event.DetailJSON != nil {
		_ = json.Unmarshal([]byte(*event.DetailJSON), &detail)
	}
	// A real PreToolUse precedes the request. Without a correlated live call we
	// cannot safely attribute a later screen to this candidate.
	if len(detail.CallIDs) == 0 {
		return
	}
	key := sid + "|" + tool
	watch := &codexPermissionWatch{wake: make(chan struct{}, 1)}
	if _, loaded := h.codexPermissionWatches.LoadOrStore(key, watch); loaded {
		return
	}
	if promptWatchActive.Add(1) > promptWatchMax {
		promptWatchActive.Add(-1)
		h.codexPermissionWatches.Delete(key)
		return
	}
	safego.Go("server/routes/codex_permission_watch", func() {
		defer h.codexPermissionWatches.Delete(key)
		defer promptWatchActive.Add(-1)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		deadline := time.NewTimer(pendingToolTTL)
		defer deadline.Stop()
		for {
			select {
			case <-deadline.C:
				return
			case <-ticker.C:
			case <-watch.wake:
			}
			if h.confirmCodexPermission(name, workingDir, event, detail.CallIDs) {
				return
			}
		}
	})
}

// confirmCodexPermission performs one observation. True means the candidate
// finished, was superseded, or was confirmed; false means it is still reviewing.
func (h *SessionsHandler) confirmCodexPermission(name, workingDir string, event *store.AgentEvent, ids []string) bool {
	sid, tool := *event.SessionID, *event.ToolName
	live := h.pending.callsFor(sid, tool, time.Now(), pendingToolTTL, "")
	found := false
	for _, id := range ids {
		for _, cur := range live {
			if id == cur {
				found = true
			}
		}
	}
	if !found {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), promptReadTimeout)
	defer cancel()
	ls, err := h.ss.GetLiveSession(ctx, sid)
	if err != nil || ls == nil || ls.IsSleeping != 0 || ls.IsArchived != 0 {
		return true
	}
	policy, reviewer := h.jsonl.ReadCodexApprovalSettings(sid, workingDir)
	if policy == "never" || reviewer != "user" {
		state := ""
		if h.backend != nil {
			if raw, err := h.backend.Replay(name); err == nil {
				state = ptymanager.CodexCLIState(raw)
			}
		}
		switch state {
		case "working", "idle":
			return false // explicit CLI state beats any stale menu
		case "blocked": // actual CLI escalation; no screen inference required
		default:
			// Only a backend without a usable native signal needs a rendered screen.
			screen, err := h.agentScreen(ctx, name, "codex", sid, "")
			if err != nil || !classifyApproval("codex", screen).Approve {
				return false
			}
		}
	}
	// Recheck correlation after the terminal read: completion/new-turn signals
	// may have arrived while a capture was in flight.
	h.codexPermissionMu.Lock()
	defer h.codexPermissionMu.Unlock()
	live = h.pending.callsFor(sid, tool, time.Now(), pendingToolTTL, "")
	found = false
	for _, id := range ids {
		for _, cur := range live {
			if id == cur {
				found = true
			}
		}
	}
	if !found {
		return true
	}
	if _, err := h.ts.InsertAgentEvent(ctx, event); err != nil {
		return false
	}
	h.notePendingToolEvent(sid, "permission_request", "")
	h.kickFeedForRequestChange(sid, "permission_request")
	h.autoAccept.Kick()
	return true
}

// Completion/new-turn signals wake the observer immediately; it need not retain
// a finished call until its next screen observation.
func (h *SessionsHandler) wakeCodexPermissionWatches(sessionID string) {
	h.codexPermissionWatches.Range(func(key, value any) bool {
		if strings.HasPrefix(key.(string), sessionID+"|") {
			select {
			case value.(*codexPermissionWatch).wake <- struct{}{}:
			default:
			}
		}
		return true
	})
}
