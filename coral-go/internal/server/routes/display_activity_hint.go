package routes

import (
	"context"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/sessionstate"
	"github.com/subgentic/coral/internal/store"
)

const displayHintSettle = 3 * time.Second
const displayHintTTL = 2 * time.Second

type displayScreenRead struct {
	mu            sync.Mutex
	at, requestAt time.Time
	stamp         string
	working       bool
}
type displayScreenCache struct {
	mu      sync.Mutex
	entries map[string]*displayScreenRead
}

func (c *displayScreenCache) entry(id string) *displayScreenRead {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]*displayScreenRead)
	}
	if e := c.entries[id]; e != nil {
		return e
	}
	// Cache only enum/time/stamp, never the captured screen. Bound ended sessions.
	if len(c.entries) >= 256 {
		for key := range c.entries {
			delete(c.entries, key)
			break
		}
	}
	e := &displayScreenRead{}
	c.entries[id] = e
	return e
}

// displayActivityHint is PRESENTATION ONLY. Call only from live payload builders,
// never the shared state reducer, board status, gate or held-send decisions.
// A working footer does not prove an approval resolved; it may only quiet the UI.
func (h *SessionsHandler) displayActivityHint(agentType, name, sessionID string, state SessionState, events []store.AgentEvent, now time.Time) (any, any) {
	if agentType != "codex" || sessionID == "" || name == "" || !state.OwnRequest || state.WaitingKind != "permission" || state.Sleeping || state.NeedsLogin || state.Stuck || state.NotStarted || state.Gone {
		return nil, nil
	}
	var requestAt time.Time
	for _, event := range events {
		e := event.StateEvent()
		switch e.Type {
		case "permission_request":
			if e.Kind != "permission" || e.At.IsZero() {
				return nil, nil
			}
			if e.At.After(requestAt) {
				requestAt = e.At
			}
		case "notification":
			if !sessionstate.IsHeldInputSummary(e.Summary) && e.Summary != sessionstate.HeldInputEndedSummary {
				return nil, nil
			}
		}
	}
	// Codex draws the dialog after the hook: do not quiet the intervening frame.
	if requestAt.IsZero() || now.Sub(requestAt) < displayHintSettle {
		return nil, nil
	}
	started := time.Now()
	stamp := h.displayOutputStamp(agentType, sessionID)
	cached := h.displayScreens.entry(sessionID)
	cached.mu.Lock()
	defer cached.mu.Unlock()
	age := now.Sub(cached.at)
	if !cached.requestAt.Equal(requestAt) || cached.stamp != stamp || age < 0 || age >= displayHintTTL {
		cached.at, cached.requestAt, cached.stamp, cached.working = now, requestAt, stamp, false
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		// Bypass the shared capture's longer stamp-based reuse: this must be a fresh
		// rendered screen, not raw/replayed terminal output or a relabelled old read.
		screen, err := h.agentScreen(ctx, name, agentType, sessionID, "")
		if err == nil && h.displayOutputStamp(agentType, sessionID) == stamp {
			cached.working = ptymanager.CodexDisplayWorkingOnScreen(screen)
		}
	}
	// Every payload rechecks age; never issue a fresh timestamp for cached evidence.
	checkedNow := now.Add(time.Since(started))
	if !cached.working || checkedNow.Sub(cached.at) < 0 || checkedNow.Sub(cached.at) >= displayHintTTL {
		return nil, nil
	}
	return "working", cached.at.UTC().Format(time.RFC3339Nano)
}
func (h *SessionsHandler) displayOutputStamp(agentType, sessionID string) string {
	if stamper, ok := h.backend.(ptymanager.OutputStamper); ok {
		if stamp, ok := stamper.OutputStamp(agentType, sessionID); ok {
			return stamp
		}
	}
	return ""
}

func (h *SessionsHandler) singleDisplayActivityHint(ctx context.Context, agentType, name, sessionID string, state SessionState) (any, any) {
	if !state.OwnRequest || state.WaitingKind != "permission" {
		return nil, nil
	}
	byID, err := h.ts.GetSessionStateEvents(ctx, []string{sessionID})
	if err != nil {
		return nil, nil
	}
	return h.displayActivityHint(agentType, name, sessionID, state, byID[sessionID], time.Now())
}

func withDisplayActivityHint(row map[string]any, hint, at any) map[string]any {
	row["display_activity_hint"], row["display_activity_hint_at"] = hint, at
	return row
}
