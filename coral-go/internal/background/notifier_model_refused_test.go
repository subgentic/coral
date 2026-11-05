package background

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// a runtime whose screen a test changes
type liveScreenRT struct {
	AgentRuntime
	mu     sync.Mutex
	screen string
}

func (r *liveScreenRT) AgentScreen(context.Context, string, string, string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.screen, nil
}
func (r *liveScreenRT) set(s string) { r.mu.Lock(); r.screen = s; r.mu.Unlock() }

// #13480: a nudge typed into a Codex agent whose model is refused starts a turn that ends at once with no work, every time (three agents sat two hours with eleven unread messages). The notifier does not type
// into one, says so once, and nudges again, with everything unread, as soon as the screen no longer shows the refusal.
func TestTheNotifierDoesNotNudgeACodexAgentWhoseModelIsRefusedAndResumesWhenItIsNot(t *testing.T) {
	ctx := context.Background()
	oldTTL := limitScreenTTL
	limitScreenTTL = 0 // the screen is read afresh at each pass
	t.Cleanup(func() { limitScreenTTL = oldTTL })
	bs := testBoardStore(t)
	const sid = "11111111-1480-4000-8000-0000000000c1"
	_, err := bs.Subscribe(ctx, "p", "Dev", "Developer", naming.SessionName("codex", sid), nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "p", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	post := func(text string) {
		_, err := bs.PostMessage(ctx, "p", "Lead", text, nil)
		require.NoError(t, err)
	}
	const refused = "› You have 2 unread messages on the message board. Run 'coral-board read' to see them.\n■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\n\n› Ask Codex to do anything\n"
	rt := &liveScreenRT{AgentRuntime: &mockRuntime{}, screen: refused}
	clock := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	n := NewBoardNotifier(bs, rt, time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	n.now = func() time.Time { return clock }
	var typed []string
	n.deliverNudge = func(_ context.Context, _ AgentRuntime, _ *slog.Logger, _, _, _, _, text, _ string, _, _ bool, _ func(context.Context) bool) (bool, error) {
		typed = append(typed, text)
		return false, nil
	}
	agent := AgentInfo{AgentType: "codex", SessionID: sid, DisplayName: "Developer", AgentName: "dev"}
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) { return []AgentInfo{agent}, nil })
	pass := func() {
		clock = clock.Add(time.Hour) // past any cache and any reminder interval
		require.NoError(t, n.runPassWith(ctx, nil, false))
	}

	post("@Dev one")
	post("@Dev two")
	pass()
	pass()
	assert.Empty(t, typed, "no nudge is typed into an agent whose turns all end with the model refused")

	rt.set("› Ask Codex to do anything\n\n  gpt-5.5 high · ~/work\n") // the model was changed: the refusal is off its screen
	pass()
	require.Len(t, typed, 1, "the nudge goes as soon as the refusal is gone")
	assert.Contains(t, typed[0], "2 unread")

	// the same screen on another agent type is no reason to hold its nudge
	rt.set(refused)
	claudeSID := "11111111-1480-4000-8000-0000000000c2"
	_, err = bs.Subscribe(ctx, "p", "Dev2", "Developer", naming.SessionName("claude", claudeSID), nil, "all")
	require.NoError(t, err)
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", SessionID: claudeSID, DisplayName: "Developer", AgentName: "dev2"}}, nil
	})
	typed = nil
	post("@Dev2 hello")
	pass()
	assert.Len(t, typed, 1, "only a Codex agent is held for a refused model")
}
