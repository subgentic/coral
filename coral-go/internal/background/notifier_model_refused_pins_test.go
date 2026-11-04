package background

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// QA Reviewer 2's three pins on #13480 (#13486): the held nudge is said once per refusal, the memory of it is forgotten when the refusal clears (so a refusal that comes back is said again), and a screen
// is read at most once per limitScreenTTL per agent.

type recordedLogs struct {
	mu   sync.Mutex
	msgs []string
}

func (r *recordedLogs) Enabled(context.Context, slog.Level) bool { return true }
func (r *recordedLogs) Handle(_ context.Context, rec slog.Record) error {
	r.mu.Lock()
	r.msgs = append(r.msgs, rec.Message)
	r.mu.Unlock()
	return nil
}
func (r *recordedLogs) WithAttrs([]slog.Attr) slog.Handler { return r }
func (r *recordedLogs) WithGroup(string) slog.Handler      { return r }
func (r *recordedLogs) heldNudgeLines() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, m := range r.msgs {
		if strings.HasPrefix(m, "no nudge: Codex refuses") {
			n++
		}
	}
	return n
}

func refusedNotifier(t *testing.T) (*BoardNotifier, *liveScreenRT, *recordedLogs, func(string), func(), *[]string) {
	t.Helper()
	ctx := context.Background()
	oldTTL := limitScreenTTL
	limitScreenTTL = 0
	t.Cleanup(func() { limitScreenTTL = oldTTL })
	bs := testBoardStore(t)
	const sid = "11111111-1486-4000-8000-0000000000d1"
	_, err := bs.Subscribe(ctx, "p", "Dev", "Developer", naming.SessionName("codex", sid), nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "p", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	post := func(text string) {
		_, err := bs.PostMessage(ctx, "p", "Lead", text, nil)
		require.NoError(t, err)
	}
	rt := &liveScreenRT{AgentRuntime: &mockRuntime{}}
	clock := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	n := NewBoardNotifier(bs, rt, time.Second)
	logs := &recordedLogs{}
	n.logger = slog.New(logs)
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
		clock = clock.Add(time.Hour)
		require.NoError(t, n.runPassWith(ctx, nil, false))
	}
	return n, rt, logs, post, pass, &typed
}

const refusedScreen = "■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\n\n› Ask Codex to do anything\n"
const workingScreen = "› Ask Codex to do anything\n\n  gpt-5.5 high · ~/work\n"

func TestAHeldNudgeForARefusedModelIsLoggedOncePerRefusal(t *testing.T) {
	_, rt, logs, post, pass, typed := refusedNotifier(t)
	rt.set(refusedScreen)
	post("@Dev one")
	for i := 0; i < 4; i++ {
		pass()
	}
	assert.Equal(t, 1, logs.heldNudgeLines(), "four passes on the same refusal say it once")
	assert.Empty(t, *typed)
	rt.set(strings.ReplaceAll(refusedScreen, "gpt-6.1-sol", "gpt-7"))
	pass()
	assert.Equal(t, 2, logs.heldNudgeLines(), "a different refused model is news, said again")
}

func TestTheMemoryOfALoggedRefusalIsForgottenWhenItClears(t *testing.T) {
	n, rt, logs, post, pass, typed := refusedNotifier(t)
	rt.set(refusedScreen)
	post("@Dev one")
	pass()
	require.Equal(t, 1, logs.heldNudgeLines())
	n.refusedMu.Lock()
	require.Len(t, n.refusedLog, 1, "remembered while it lasts")
	n.refusedMu.Unlock()

	rt.set(workingScreen) // cleared
	pass()
	require.Len(t, *typed, 1, "the held nudge goes once the refusal is gone")
	n.refusedMu.Lock()
	assert.Empty(t, n.refusedLog, "the refusal cleared: nothing is remembered of it")
	n.refusedMu.Unlock()

	rt.set(refusedScreen) // it comes back
	post("@Dev two")
	pass()
	assert.Equal(t, 2, logs.heldNudgeLines(), "a refusal that returns is said again")
}

type countingScreenRT struct {
	AgentRuntime
	mu    sync.Mutex
	reads int
}

func (r *countingScreenRT) AgentScreen(context.Context, string, string, string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reads++
	return refusedScreen, nil
}

func TestAScreenIsReadAtMostOncePerCacheWindowPerAgent(t *testing.T) {
	ctx := context.Background()
	rt := &countingScreenRT{AgentRuntime: &mockRuntime{}}
	read, _ := screenModelRefusedSized(rt)
	require.NotNil(t, read)
	a := AgentInfo{AgentType: "codex", SessionID: "11111111-1486-4000-8000-0000000000e1"}
	other := AgentInfo{AgentType: "codex", SessionID: "11111111-1486-4000-8000-0000000000e2"}
	for i := 0; i < 5; i++ {
		model, ok := read(ctx, a)
		assert.True(t, ok)
		assert.Equal(t, "gpt-6.1-sol", model)
	}
	assert.Equal(t, 1, rt.reads, "five asks inside the window read the screen once")
	read(ctx, other)
	assert.Equal(t, 2, rt.reads, "another agent has its own read")

	old := limitScreenTTL
	limitScreenTTL = 0
	t.Cleanup(func() { limitScreenTTL = old })
	read(ctx, a)
	assert.Equal(t, 3, rt.reads, "past the window the screen is read again")
}
