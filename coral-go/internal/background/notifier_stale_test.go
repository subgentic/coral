package background

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/terminalinput"
)

const menuScreen = " Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"

// screenRuntime is a runtime whose screen the test sets (a menu holds Coral's sends), and which
// records what is typed. onScreen, when set, runs on each screen read, before the screen is
// returned.
type screenRuntime struct {
	mockRuntime
	smu      sync.Mutex
	screen   string
	onScreen func()
}

func (r *screenRuntime) AgentScreen(context.Context, string, string, string) (string, error) {
	r.smu.Lock()
	f, s := r.onScreen, r.screen
	r.smu.Unlock()
	if f != nil {
		f()
	}
	return s, nil
}

func (r *screenRuntime) setScreen(s string) { r.smu.Lock(); r.screen = s; r.smu.Unlock() }

func (r *screenRuntime) typed() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, c := range r.sent {
		out = append(out, c.text)
	}
	return out
}

// staleSetup: Worker on board-X, tagged in one unread message, and a notifier that finds it.
func staleSetup(t *testing.T) (*BoardNotifier, *board.Store, *screenRuntime, string) {
	t.Helper()
	bs := testBoardStore(t)
	rt := &screenRuntime{screen: "working on it\n"}
	ctx := context.Background()
	n := NewBoardNotifier(bs, rt, time.Hour)
	n.SetIsPausedFn(func(string) bool { return false })
	for _, s := range []struct{ id, session string }{{"Worker", "claude-5555-0001"}, {"Poster", "claude-5555-0002"}} {
		_, err := bs.Subscribe(ctx, "board-X", s.id, s.id, s.session, nil, "")
		require.NoError(t, err)
	}
	_, err := bs.PostMessage(ctx, "board-X", "Poster", "@Worker please check", nil)
	require.NoError(t, err)
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentName: "worker", AgentType: "claude", SessionID: "5555-0001", DisplayName: "Worker"}}, nil
	})
	name := "claude-5555-0001"
	t.Cleanup(func() { ptymanager.ForgetSession(name) })
	return n, bs, rt, name
}

// Not held at all: the agent reads between the notifier's count and the typing (the gate looks at
// the screen in between). Nothing is typed.
func TestBoardNotifier_ANudgeReadBeforeItIsTypedIsDropped(t *testing.T) {
	n, bs, rt, _ := staleSetup(t)
	ctx := context.Background()
	var once sync.Once
	rt.smu.Lock()
	rt.onScreen = func() { once.Do(func() { _, _ = bs.ReadMessages(context.Background(), "board-X", "Worker", 50) }) }
	rt.smu.Unlock()
	require.NoError(t, n.RunOnce(ctx))
	assert.Empty(t, rt.typed(), "read before it went: not typed")

	// A nudge that was dropped is not recorded as sent: a new message is announced at once.
	rt.smu.Lock()
	rt.onScreen = nil
	rt.smu.Unlock()
	_, err := bs.PostMessage(ctx, "board-X", "Poster", "@Worker one more", nil)
	require.NoError(t, err)
	require.NoError(t, n.RunOnce(ctx))
	typed := rt.typed()
	require.Len(t, typed, 1)
	assert.Contains(t, typed[0], "1 unread message on the message board")
}

// pasteRuntime takes Coral's sends as a bracketed paste (PromptSender), the path where the gate
// runs the send's Ready check before pasting.
type pasteRuntime struct{ screenRuntime }

func (r *pasteRuntime) SendPrompt(_ context.Context, _ terminalinput.Origin, name, text, _, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, sendCall{session: name, text: text})
	return nil
}
