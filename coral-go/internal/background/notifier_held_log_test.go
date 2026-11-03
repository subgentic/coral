package background

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// An agent whose CLI has exited gets no nudge typed (its shell is not typed into), and the notifier used to say "sending nudge" again on every pass, every few seconds, for as long as it stayed so (#12714):
// the line is written when the nudge changes (a new count or a newer message), not on every pass over the same held one.
func TestAHeldNudgeIsLoggedOnceNotOnEveryPass(t *testing.T) {
	ctx := context.Background()
	bs := testBoardStore(t)
	const sid = "11111111-1387-4000-8000-0000000012b1"
	_, err := bs.Subscribe(ctx, "p", "Dev", "Developer", naming.SessionName("claude", sid), nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "p", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	post := func(text string) {
		_, err := bs.PostMessage(ctx, "p", "Lead", text, nil)
		require.NoError(t, err)
	}
	clock := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	n := NewBoardNotifier(bs, &mockRuntime{}, time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	n.now = func() time.Time { return clock }
	logs := captureNotifierLogs(n)
	n.deliverNudge = func(_ context.Context, _ AgentRuntime, _ *slog.Logger, _, _, _, _, _, _ string, _, _ bool, _ func(context.Context) bool) (bool, error) {
		return true, nil // the CLI has exited: nothing is typed
	}
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", SessionID: sid, DisplayName: "Developer", AgentName: "dev"}}, nil
	})
	pass := func() {
		clock = clock.Add(5 * time.Second)
		require.NoError(t, n.runPassWith(ctx, nil, false))
	}
	sent := func() int { return strings.Count(logs.String(), `msg="sending nudge"`) }

	post("@Dev one")
	for i := 0; i < 6; i++ {
		pass()
	}
	assert.Equal(t, 1, sent(), "six passes over the same held nudge: one line, not six")

	post("@Dev two") // the state changed: a new count
	for i := 0; i < 4; i++ {
		pass()
	}
	assert.Equal(t, 2, sent(), "a change is said once more")
}
