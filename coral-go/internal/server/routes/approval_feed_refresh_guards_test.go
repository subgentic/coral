package routes

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestApprovalFeed8118CodexOnly(t *testing.T) {
	for _, agentType := range []string{"claude", "agy", "", "Codex"} {
		t.Run(agentType, func(t *testing.T) {
			_, h, _, _ := setupSessionsTestServer(t)
			kicks, unsubscribe := h.wsKick.subscribe()
			defer unsubscribe()
			sid := uuid.NewString()
			cached := h.displayScreens.entry(sid)
			h.refreshAfterConfirmedAnswer(context.Background(), agentType, sid)
			require.Same(t, cached, h.displayScreens.entries[sid])
			require.Empty(t, h.approvalRefresh.pending)
			select {
			case <-kicks:
				t.Fatal("a non-Codex answer refreshed the feed")
			default:
			}
		})
	}
}

func TestApprovalFeed8118FutureRequestBoundsDelay(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	sid := uuid.NewString()
	event := displayRequest(time.Now().Add(time.Hour))[0]
	event.SessionID = &sid
	_, err := h.ts.InsertAgentEvent(context.Background(), &event)
	require.NoError(t, err)
	kicks, unsubscribe := h.wsKick.subscribe()
	defer unsubscribe()
	h.refreshAfterConfirmedAnswer(context.Background(), "codex", sid)
	select {
	case <-kicks: // Even with clock skew, the immediate read remains available.
	default:
		t.Fatal("confirmed answer did not request its immediate read")
	}
	// The existing implementation skips a deferred read outside (0, 3s]. It
	// does not install a request+1h timer; no clamping change is needed.
	require.Empty(t, h.approvalRefresh.pending)
	select {
	case <-kicks:
		t.Fatal("future request produced an extra refresh")
	default:
	}
}

func TestApprovalFeed8118AnswerReplacesTimer(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	sid := uuid.NewString()
	event := displayRequest(time.Now())[0]
	event.SessionID = &sid
	_, err := h.ts.InsertAgentEvent(context.Background(), &event)
	require.NoError(t, err)
	h.refreshAfterConfirmedAnswer(context.Background(), "codex", sid)
	first := h.approvalRefresh.pending[sid]
	require.NotNil(t, first)
	defer first.Stop()
	h.refreshAfterConfirmedAnswer(context.Background(), "codex", sid)
	second := h.approvalRefresh.pending[sid]
	require.NotNil(t, second)
	defer second.Stop()
	require.NotSame(t, first, second)
	require.False(t, first.Stop(), "replacement must stop the old timer")
	require.True(t, second.Stop(), "the replacement remains scheduled")
}

func TestApprovalFeed8118TimerIdentity(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	sid := uuid.NewString()
	stale := time.NewTimer(time.Hour)
	current := time.NewTimer(time.Hour)
	defer stale.Stop()
	defer current.Stop()
	h.approvalRefresh.pending = map[string]*time.Timer{sid: current}
	cached := h.displayScreens.entry(sid)
	kicks, unsubscribe := h.wsKick.subscribe()
	defer unsubscribe()
	finish := func(timer *time.Timer) {
		h.approvalRefresh.mu.Lock()
		h.finishApprovalFeedRefreshLocked(sid, timer)
	}
	// Simulate the old callback already running when a newer answer replaced it.
	finish(stale)
	require.Same(t, current, h.approvalRefresh.pending[sid], "stale callback cannot remove replacement")
	require.Same(t, cached, h.displayScreens.entries[sid], "stale callback cannot invalidate fresh evidence")
	select {
	case <-kicks:
		t.Fatal("stale timer refreshed the feed")
	default:
	}
	// The matching callback must still do all three jobs, exactly once.
	finish(current)
	require.Empty(t, h.approvalRefresh.pending)
	require.NotContains(t, h.displayScreens.entries, sid)
	select {
	case <-kicks:
	default:
		t.Fatal("current timer did not refresh the feed")
	}
	finish(current)
	select {
	case <-kicks:
		t.Fatal("completed timer refreshed twice")
	default:
	}
}
