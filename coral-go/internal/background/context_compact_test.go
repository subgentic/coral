package background

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
)

// A mock agent for the compactor (#14849): its state, context and unread count are what the test says, and what is typed to it is recorded.
type compactHarness struct {
	t       *testing.T
	bs      *board.Store
	c       *ContextCompact
	now     time.Time
	sig     map[string]agentSignal
	tokens  map[string]int
	unread  map[string]int
	limited map[string]bool
	skip    bool  // the gate skips the send (a dialog, a draft)
	failure error // the send fails
	paused  bool
	mu      sync.Mutex
	typed   []string // "agent: text"
	agents  []AgentInfo
}

func newCompactHarness(t *testing.T, on bool) *compactHarness {
	t.Helper()
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := &compactHarness{t: t, bs: bs, now: time.Now().UTC().Truncate(time.Second), sig: map[string]agentSignal{}, tokens: map[string]int{}, unread: map[string]int{}, limited: map[string]bool{}}
	h.c = NewContextCompact(bs, func(context.Context) ([]AgentInfo, error) { return h.agents, nil })
	h.c.now = func() time.Time { return h.now }
	h.c.signal = func(_ context.Context, id string) (agentSignal, bool) { s, ok := h.sig[id]; return s, ok }
	h.c.limit = func(_ context.Context, a AgentInfo) (time.Duration, bool) { return 0, h.limited[a.SessionID] }
	h.c.tokens = func(_ context.Context, ids []string) (map[string]int, error) {
		out := map[string]int{}
		for _, id := range ids {
			out[id] = h.tokens[id]
		}
		return out, nil
	}
	h.c.unread = func(_ context.Context, names []string) (map[string]board.SessionUnread, error) {
		out := map[string]board.SessionUnread{}
		for _, n := range names {
			out[n] = board.SessionUnread{Unread: h.unread[n]}
		}
		return out, nil
	}
	h.c.paused = func(string) bool { return h.paused }
	h.c.deliver = func(_ context.Context, a AgentInfo, text string) (bool, error) {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.failure != nil {
			return false, h.failure
		}
		if h.skip {
			return false, nil
		}
		h.typed = append(h.typed, a.DisplayName+": "+text)
		return true, nil
	}
	if on {
		s := board.DefaultHealthSettings()
		s.CompactContext.On = true
		require.NoError(t, bs.SetHealthSettings(context.Background(), "team", s))
	}
	return h
}

// agent subscribes name with a live session that has been idle for idle, with tokens of context.
func (h *compactHarness) agent(name, sid, agentType, title string, tokens int, idle time.Duration) string {
	h.t.Helper()
	sn := naming.SessionName(agentType, sid)
	_, err := h.bs.Subscribe(context.Background(), "team", name, title, sn, nil, "all", true)
	require.NoError(h.t, err)
	h.agents = append(h.agents, AgentInfo{AgentType: agentType, SessionID: sid, DisplayName: name})
	h.sig[sid] = agentSignal{Since: h.now.Add(-idle), LastEvent: h.now.Add(-idle)}
	h.tokens[sid] = tokens
	return sn
}

func (h *compactHarness) run(after time.Duration) {
	h.now = h.now.Add(after)
	h.c.RunOnce(context.Background())
}

func (h *compactHarness) sent() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.typed...)
}

const compactLine = "Dev: /compact keep: open tasks, team rules, recent decisions, and what I was last asked"

func TestAnIdleAgentWithALargeContextGetsExactlyOneCompact(t *testing.T) {
	h := newCompactHarness(t, true)
	h.agent("Dev", "s1", "claude", "Dev", 312000, time.Minute)
	h.run(0)
	assert.Equal(t, []string{compactLine}, h.sent())
	h.run(time.Minute)
	h.run(10 * time.Minute)
	assert.Len(t, h.sent(), 1, "one compaction: its next turn's context says whether another is due")
	h.run(31 * time.Minute)
	assert.Len(t, h.sent(), 2, "after the cooldown, a context that is still large is compacted again")
	at, n, ok := h.c.LastCompacted(naming.SessionName("claude", "s1"))
	assert.True(t, ok)
	assert.Equal(t, 312000, n)
	assert.WithinDuration(t, h.now, at, time.Second)
}

func TestABusyAgentOrOneAtADialogGetsNone(t *testing.T) {
	h := newCompactHarness(t, true)
	h.agent("Busy", "s1", "claude", "Dev", 400000, time.Minute)
	h.agent("Asking", "s2", "claude", "Dev", 400000, time.Minute)
	h.agent("Just", "s3", "claude", "Dev", 400000, 5*time.Second)
	h.sig["s1"] = agentSignal{InTurn: true, Since: h.now.Add(-time.Hour)}
	h.sig["s2"] = agentSignal{NeedsInput: true, Since: h.now.Add(-time.Hour)}
	h.run(0)
	assert.Empty(t, h.sent(), "a turn is never interrupted, a dialog never answered, a turn that has only just ended is given time")
	h.run(30 * time.Second)
	assert.Equal(t, []string{"Just: /compact keep: open tasks, team rules, recent decisions, and what I was last asked"}, h.sent(), "the one that has been idle long enough is compacted")
}

func TestNothingIsTypedForTheOtherReasonsToWait(t *testing.T) {
	cases := map[string]func(h *compactHarness, sn string){
		"unread board messages (a turn is about to start)": func(h *compactHarness, sn string) { h.unread[sn] = 1 },
		"a context under the threshold":                    func(h *compactHarness, sn string) { h.tokens["s1"] = 150000 },
		"a usage limit":                                    func(h *compactHarness, sn string) { h.limited["s1"] = true },
		"a paused board":                                   func(h *compactHarness, sn string) { h.paused = true },
		"a send the gate skipped":                          func(h *compactHarness, sn string) { h.skip = true },
		"a send that failed":                               func(h *compactHarness, sn string) { h.failure = errors.New("no terminal") },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			h := newCompactHarness(t, true)
			sn := h.agent("Dev", "s1", "claude", "Dev", 312000, time.Minute)
			change(h, sn)
			h.run(0)
			assert.Empty(t, h.sent())
			_, _, did := h.c.LastCompacted(sn)
			assert.False(t, did, "nothing sent is nothing remembered: it is asked again on the next pass")
		})
	}
}

func TestASkippedSendIsAskedAgainOnTheNextPass(t *testing.T) {
	h := newCompactHarness(t, true)
	h.agent("Dev", "s1", "claude", "Dev", 312000, time.Minute)
	h.skip = true
	h.run(0)
	h.skip = false
	h.run(time.Minute)
	assert.Equal(t, []string{compactLine}, h.sent())
}

func TestTheSettingIsOffByDefaultAndEachTeamHasItsOwn(t *testing.T) {
	h := newCompactHarness(t, false)
	h.agent("Dev", "s1", "claude", "Dev", 900000, time.Hour)
	h.run(0)
	assert.Empty(t, h.sent(), "off unless the team turned it on")
	assert.False(t, board.DefaultHealthSettings().CompactContext.On)
	assert.Equal(t, 200, board.DefaultHealthSettings().CompactContext.ThresholdK)
}

func TestTheOrchestratorAndOtherCLIsAreLeftAlone(t *testing.T) {
	h := newCompactHarness(t, true)
	h.agent("Boss", "s1", "claude", "Orchestrator", 500000, time.Minute)
	h.agent("Cx", "s2", "codex", "Dev", 500000, time.Minute)
	h.agent("Dev", "s3", "claude", "Dev", 500000, time.Minute)
	h.run(0)
	assert.Equal(t, []string{compactLine}, h.sent(), "the orchestrator holds the most state and a CLI with no known command is never guessed at")
	s := board.DefaultHealthSettings()
	s.CompactContext = board.HealthCompact{On: true, ThresholdK: 200, Orchestrator: true}
	require.NoError(t, h.bs.SetHealthSettings(context.Background(), "team", s))
	h.run(time.Minute)
	require.Len(t, h.sent(), 2)
	assert.Contains(t, h.sent()[1], "Boss: /compact ")
}

func TestTheCompactLineIsFixedWhateverTheAgentWasDoing(t *testing.T) {
	assert.Equal(t, "/compact keep: open tasks, team rules, recent decisions, and what I was last asked", compactCommand("claude"))
	for _, other := range []string{"codex", "agy", "hermes", "pi", "opencode", "gemini", "terminal", ""} {
		assert.Empty(t, compactCommand(other), other)
	}
}

// The one typed line that is not a notice (the typed-notice census lists it as an exception): it is fixed, one line, and holds nothing a shell acts on, so where a terminal is not the CLI's it is at worst a path that does not exist.
func TestTheCompactLineIsFixedAndHoldsNothingAShellActsOn(t *testing.T) {
	line := compactCommand("claude")
	assert.NotContains(t, line, "\n")
	for _, bad := range []string{"`", "$(", "${", "<", ">", "|", "&", ";", "\"", "'", "{", "}", "@", "[", "]", "\\", "!", "*", "~", "%", "^", "(", ")"} {
		assert.NotContains(t, line, bad)
	}
	assert.Equal(t, line, compactCommand("claude"), "the same line every time")
}
