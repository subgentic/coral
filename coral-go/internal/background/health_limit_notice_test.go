package background

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// limitPosts are the board posts that announce a usage limit.
func (h *checkHarness) limitPosts() []string {
	h.t.Helper()
	msgs, err := h.s.ListMessages(context.Background(), "team", 500, 0, 0)
	require.NoError(h.t, err)
	var out []string
	for _, m := range msgs {
		if strings.Contains(m.Content, "usage limit") {
			out = append(out, m.Content)
		}
	}
	return out
}

// Brief task 1 (#21018): a limit hit is one post to the Orchestrator with the agent, its open task, the vendor and the reset time; the many scans and retries
// while the agent stays blocked add nothing, and a new hit after the limit lifted is a new post.
func TestALimitHitIsOnePostToTheOrchestrator(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 40*time.Minute)
	task, err := h.s.CreateTask(ctx, "team", "Change the Go code", "", "high", "Orchestrator", "Dev")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	devSID := h.sid(2)
	blocked := true
	h.m.limit = func(_ context.Context, a AgentInfo) (time.Duration, bool) {
		return 2*time.Hour + 5*time.Minute, blocked && a.SessionID == devSID
	}

	for i := 0; i < 5; i++ { // the screen is read again at every scan: a retry, a nudge, the roster
		h.now = h.now.Add(11 * time.Minute)
		h.m.scan(ctx)
	}
	posts := h.limitPosts()
	require.Len(t, posts, 1, "one post for the hit, not one per scan: %q", posts)
	p := posts[0]
	assert.Contains(t, p, "@Orchestrator")
	assert.Contains(t, p, "Dev")
	assert.Contains(t, p, "#"+fmt.Sprint(task.ID), "the open task")
	assert.Contains(t, p, "claude", "the vendor")
	assert.Contains(t, p, "2 h 5 min", "the reset time")

	// The limit lifts, and a later hit is a new post.
	blocked = false
	h.now = h.now.Add(11 * time.Minute)
	h.m.scan(ctx)
	h.now = h.now.Add(limitHitClearAfter + time.Minute)
	h.m.scan(ctx)
	blocked = true
	h.now = h.now.Add(11 * time.Minute)
	h.m.scan(ctx)
	assert.Len(t, h.limitPosts(), 2)
}

// With no Orchestrator the notice is a question to the Operator (Needs you).
func TestALimitHitWithNoOrchestratorGoesToNeedsYou(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Dev", "Developer", 2, 40*time.Minute)
	_, err := h.s.Subscribe(ctx, "team", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	h.m.limit = func(context.Context, AgentInfo) (time.Duration, bool) { return 0, true }
	for i := 0; i < 3; i++ {
		h.now = h.now.Add(11 * time.Minute)
		h.m.scan(ctx)
	}
	require.Len(t, h.limitPosts(), 1)
	asks, err := h.s.OpenAsks(ctx, "team", h.now)
	require.NoError(t, err)
	require.Len(t, asks, 1, "one open question for the Operator")
	assert.Equal(t, "Operator", asks[0].Member)
	assert.Contains(t, asks[0].Content, "reset time not shown")
}
