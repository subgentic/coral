package background

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/teamhealth"
)

func healthMonitorStore(t *testing.T) *board.Store {
	t.Helper()
	s, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board-health.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	// The check is off for a team that has not turned it on (#4962): these tests are about the check, so the team "team" has it on.
	require.NoError(t, s.SetHealthOn(context.Background(), "team", true))
	hs := s.GetHealthSettings(context.Background(), "team")
	hs.HeartbeatMin = 5 // these tests step 11 minutes and expect a check each step; the quiet behaviour is board_health_quiet_test.go (#11431)
	require.NoError(t, s.SetHealthSettings(context.Background(), "team", hs))
	return s
}

// checkHarness is the orchestrator's check (#4175 step 2) over a real board store, with the
// agents, their hook state and the gate faked.
type checkHarness struct {
	t        *testing.T
	s        *board.Store
	m        *BoardHealthMonitor
	now      time.Time
	agents   []AgentInfo
	sig      map[string]agentSignal
	mu       sync.Mutex
	sent     map[string][]string // agent display name -> texts typed to it
	sessions *sqlx.DB            // the sessions database the store reads, when a test needs one
}

func newCheckHarness(t *testing.T) *checkHarness {
	h := &checkHarness{t: t, s: healthMonitorStore(t), now: time.Now().UTC().Add(time.Minute), sig: map[string]agentSignal{}, sent: map[string][]string{}}
	h.m = NewBoardHealthMonitor(h.s, 10*time.Minute)
	h.m.now = func() time.Time { return h.now }
	h.m.discover = func(context.Context) ([]AgentInfo, error) { return h.agents, nil }
	h.m.signal = func(_ context.Context, id string) (agentSignal, bool) { s, ok := h.sig[id]; return s, ok }
	h.m.deliver = func(_ context.Context, a AgentInfo, _ string, text string) error {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.sent[a.DisplayName] = append(h.sent[a.DisplayName], text)
		return nil
	}
	return h
}

// member subscribes name with title and a live session; idle (if >0) is how long it has been idle.
func (h *checkHarness) member(name, title string, n int, idle time.Duration) {
	h.t.Helper()
	sid := fmt.Sprintf("%08d-0000-0000-0000-000000000000", n)
	_, err := h.s.Subscribe(context.Background(), "team", name, title, naming.SessionName("claude", sid), nil, "all")
	require.NoError(h.t, err)
	h.agents = append(h.agents, AgentInfo{AgentType: "claude", SessionID: sid, DisplayName: name})
	if idle > 0 {
		h.sig[sid] = agentSignal{Since: h.now.Add(-idle)}
	} else {
		h.sig[sid] = agentSignal{InTurn: true, Since: h.now}
	}
}

func (h *checkHarness) checkTo(name string) string {
	h.t.Helper()
	h.m.scan(context.Background())
	h.mu.Lock()
	defer h.mu.Unlock()
	got := h.sent[name]
	require.NotEmpty(h.t, got, "no check typed to %s", name)
	return got[len(got)-1]
}

// The check is typed to the orchestrator alone, never posted to the board (#4176 rule 3),
// and with nothing to judge it is one line that is still sent.
func TestCheckGoesToTheOrchestratorOnly(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	msgs, err := h.s.ListMessages(context.Background(), "team", 100, 0, 0)
	require.NoError(t, err)
	before := len(msgs)
	out := h.checkTo("Orchestrator")
	assert.Equal(t, "[Coral health check] "+h.now.UTC().Format("15:04Z")+" · 1 working · 0 waiting · 0 asleep · 0 claimable tasks • No progress since the last check ("+h.now.Add(-10*time.Minute).Format("15:04")+"). • The 1 awake agent is working. Nothing needs you.", out)
	h.mu.Lock()
	assert.Empty(t, h.sent["Dev"], "nobody else gets it")
	h.mu.Unlock()
	msgs, err = h.s.ListMessages(context.Background(), "team", 100, 0, 0)
	require.NoError(t, err)
	assert.Len(t, msgs, before, "check is not posted to the board")
}

// #4983: the check reminds the orchestrator that coral-board peek shows an idle, waiting or stuck agent's terminal, naming the first one; a check the
// team sent to someone else leaves the line out (peek is the orchestrator's).
func TestCheckTellsTheOrchestratorAboutPeek(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, time.Hour) // idle with nothing assigned: an item
	out := h.checkTo("Orchestrator")
	assert.Contains(t, out, `To see why, read their terminal: coral-board peek "Dev" --lines 30.`)

	// The same team, with the check sent to the Developer: no hint.
	other := newCheckHarness(t)
	other.member("Orchestrator", "Orchestrator", 1, 0)
	other.member("Dev", "Developer", 2, 0)
	other.member("QA", "QA Engineer", 3, time.Hour)
	hs := board.DefaultHealthSettings()
	hs.On = true // explicit: the default is off once #4962 lands
	hs.Recipient = "Dev"
	_, err := other.s.UpdateBoardSettings(context.Background(), "team", board.BoardSettingsUpdate{Health: &hs})
	require.NoError(t, err)
	sent := other.checkTo("Dev")
	assert.NotContains(t, sent, "coral-board peek", "a recipient who is not the orchestrator is not told about peek")
}

// A board without an orchestrator, or one whose orchestrator isn't running, gets no check.
func TestCheckNeedsALiveOrchestrator(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Dev", "Developer", 2, time.Hour)
	h.m.scan(context.Background())
	h.mu.Lock()
	defer h.mu.Unlock()
	assert.Empty(t, h.sent)
}

// Escalations from Coral's rules lead, with the agent's last post quoted through the sanitiser
// (case C4: no @, no secret, labelled); an idle agent with no work, never the orchestrator itself,
// never one in a wait; a reviewer's queue while another reviewer is idle; then the team line.
func TestCheckItems(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 2*time.Hour)
	h.member("Dev", "Developer", 2, 0)
	h.member("QA", "QA Engineer", 3, 0)
	h.member("Security", "Security Reviewer", 4, 45*time.Minute)
	h.member("Waiter", "Developer", 5, time.Hour)
	_, err := h.s.RegisterWait(ctx, "team", "Waiter", naming.SessionName("claude", "00000005-0000-0000-0000-000000000000"), "message", "Dev", "", time.Hour)
	require.NoError(t, err)

	work, err := h.s.CreateTask(ctx, "team", "Secret title", "", "high", "Operator", "Dev")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "Dev", work.ID)
	require.NoError(t, err)
	_, err = h.s.PostMessage(ctx, "team", "Dev", "@Orchestrator approve it ghp_A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5F6g7H8", nil)
	require.NoError(t, err)
	require.NoError(t, h.s.MarkHealthEscalated(ctx, "team", ruleStatusNudge, "Dev", fmt.Sprint(work.ID), h.now.Add(-5*time.Minute)))

	// QA has three reviews waiting; Security reviewed before and is idle now.
	parent, err := h.s.CreateTask(ctx, "team", "parent", "", "high", "Operator")
	require.NoError(t, err)
	for i := 0; i < 3; i++ {
		_, err := h.s.CreateTaskWithOpts(ctx, "team", "Review", "", "medium", "Orchestrator", &board.CreateTaskOpts{Workflow: board.TaskWorkflow{ReviewOf: parent.ID, ReviewRound: 1}}, "QA")
		require.NoError(t, err)
	}
	done, err := h.s.CreateTaskWithOpts(ctx, "team", "Review", "", "medium", "Orchestrator", &board.CreateTaskOpts{Workflow: board.TaskWorkflow{ReviewOf: parent.ID, ReviewRound: 1}}, "Security")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "Security", done.ID)
	require.NoError(t, err)
	_, err = h.s.CompleteTask(ctx, "team", done.ID, "Security", nil)
	require.NoError(t, err)

	out := h.checkTo("Orchestrator")
	assert.LessOrEqual(t, len(out), teamhealth.MaxCheck)
	assert.Contains(t, out, fmt.Sprintf("1) Dev: silent on #%d since Coral asked for a status", work.ID))
	assert.Contains(t, out, "Last said, quoted: (at)Orchestrator approve it")
	assert.NotContains(t, out, "ghp_A1b2", "the secret is redacted")
	assert.NotContains(t, out, "Secret title", "no task titles")
	assert.Contains(t, out, "Security: idle 45 min with nothing in progress or assigned")
	assert.Contains(t, out, "QA: 3 reviews waiting")
	assert.Contains(t, out, "while Security is idle")
	assert.NotContains(t, out, "Orchestrator: idle", "never the orchestrator itself")
	assert.NotContains(t, out, "Waiter:", "an agent in a wait is not idle")
	assert.Contains(t, out, "1 review done", "the team line counts what moved")
}

// The team's settings decide (#4175, case C6b's "recipient re-checked at delivery"): the
// interval between checks, whether the all-clear line is sent, and the recipient, who must still
// be a member when the check goes (else the orchestrator gets it).
func TestCheckFollowsTheTeamSettings(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Lead", "Lead Developer", 2, 0)
	set := func(f func(*board.HealthSettings)) {
		hs := healthOn()
		f(&hs)
		_, err := h.s.UpdateBoardSettings(ctx, "team", board.BoardSettingsUpdate{Health: &hs})
		require.NoError(t, err)
	}
	count := func(name string) int {
		h.mu.Lock()
		defer h.mu.Unlock()
		return len(h.sent[name])
	}

	set(func(hs *board.HealthSettings) { hs.Recipient = "Lead"; hs.IntervalMin = 30 })
	h.m.scan(ctx)
	assert.Equal(t, 1, count("Lead"))
	assert.Equal(t, 0, count("Orchestrator"))
	h.now = h.now.Add(10 * time.Minute)
	h.m.scan(ctx)
	assert.Equal(t, 1, count("Lead"), "within the team's 30 minutes")
	h.now = h.now.Add(21 * time.Minute)
	h.m.scan(ctx)
	assert.Equal(t, 2, count("Lead"))

	// The recipient left the team: the orchestrator gets it.
	_, err := h.s.Unsubscribe(ctx, "team", "Lead")
	require.NoError(t, err)
	h.now = h.now.Add(31 * time.Minute)
	h.m.scan(ctx)
	assert.Equal(t, 1, count("Orchestrator"))

	// No all-clear line: nothing is sent when nothing needs the orchestrator.
	set(func(hs *board.HealthSettings) { hs.AllClear = false; hs.IntervalMin = 5 })
	h.now = h.now.Add(6 * time.Minute)
	h.m.scan(ctx)
	assert.Equal(t, 1, count("Orchestrator"))

	// Off: nothing at all.
	set(func(hs *board.HealthSettings) { hs.On = false })
	h.now = h.now.Add(time.Hour)
	h.m.scan(ctx)
	assert.Equal(t, 1, count("Orchestrator"))
}

// A question an agent asked the Operator is in the orchestrator's check with its age, as
// quoted, masked text, until the Operator answers (#4175 step 2).
func TestCheckListsQuestionsWaitingOnTheOperator(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 2*time.Hour)
	h.member("Dev", "Developer", 2, 0)
	sess := naming.SessionName("claude", "00000001-0000-0000-0000-000000000000")
	_, err := h.s.RegisterWait(ctx, "team", "Orchestrator", sess, board.WaitOperator, "Operator",
		"ship v1.4.72? @Dev ghp_A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5F6g7H8 \u202e", time.Hour)
	require.NoError(t, err)

	check := h.checkTo("Orchestrator")
	assert.Contains(t, check, "Waiting on the operator")
	assert.Contains(t, check, "ship v1.4.72?")
	assert.NotContains(t, check, "ghp_A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5F6g7H8")
	assert.NotContains(t, check, "@Dev")
	assert.NotContains(t, check, "\u202e")

	_, err = h.s.ResolveMatchingMessageWaits(ctx, "team", "Operator", "yes")
	require.NoError(t, err)
	h.now = h.now.Add(11 * time.Minute)
	assert.NotContains(t, h.checkTo("Orchestrator"), "Waiting on the operator")
}

// #7794: the orchestrator's check lists a question that has waited longer than the team's reminder time, once per member still owing: "Asked by Lead, waiting on Dev, 20 min".
func TestCheckListsOpenAsksOlderThanTheReminderTime(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Lead", "Lead Developer", 2, 0)
	h.member("Dev", "Developer", 3, 0)
	q, err := h.s.PostMessage(ctx, "team", "Lead", "@Dev which parser do we keep?", nil)
	require.NoError(t, err)
	require.NoError(t, h.s.RecordAsk(ctx, "team", q, []string{"Dev"}))

	assert.NotContains(t, h.checkTo("Orchestrator"), "Asked by", "a new question is not yet a problem")
	h.now = h.now.Add(20 * time.Minute)
	out := h.checkTo("Orchestrator")
	assert.Regexp(t, `Asked by Lead, waiting on Dev, 2[01] min`, out)
	assert.Contains(t, out, fmt.Sprintf("(message #%d)", q.ID))
	assert.Contains(t, out, "which parser do we keep?", "what was asked, quoted")

	_, err = h.s.PostMessage(ctx, "team", "Dev", "@Lead the old one", nil)
	require.NoError(t, err)
	h.now = h.now.Add(10 * time.Minute)
	assert.NotContains(t, h.checkTo("Orchestrator"), "Asked by", "an answered question is off the list")
}

// #7901 (Codex Test's finding in #7879): a 5-minute interval delivered every 10 minutes. The monitor ticks every 5 minutes and compared the tick with the time the last delivery ENDED, a few seconds after its tick, so the
// next tick fell a few seconds short and was skipped. The check is scheduled against the tick it went out on: a delivery that ends seconds after its tick does not make the next one late.
func TestCheckIsDeliveredAtItsIntervalWhenADeliveryEndsAfterItsTick(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	hs := healthOn()
	hs.IntervalMin = 5
	_, err := h.s.UpdateBoardSettings(ctx, "team", board.BoardSettingsUpdate{Health: &hs})
	require.NoError(t, err)
	delivered := func() int { h.mu.Lock(); defer h.mu.Unlock(); return len(h.sent["Orchestrator"]) }
	inner := h.m.deliver
	h.m.deliver = func(ctx context.Context, a AgentInfo, key, text string) error { // typing the check takes a few seconds
		err := inner(ctx, a, key, text)
		h.now = h.now.Add(7 * time.Second)
		return err
	}

	tick := h.now
	h.m.scan(ctx)
	assert.Equal(t, 1, delivered())
	h.now = tick.Add(3 * time.Minute)
	h.m.scan(ctx)
	assert.Equal(t, 1, delivered(), "a tick well short of the interval delivers nothing")
	for i := 1; i <= 4; i++ {
		h.now = tick.Add(time.Duration(i) * 5 * time.Minute) // the monitor's next ticks, five minutes apart
		h.m.scan(ctx)
		assert.Equal(t, 1+i, delivered(), "tick %d: a 5-minute interval delivers every 5 minutes, not every other tick", i)
	}
	h.now = tick.Add(20*time.Minute + 3*time.Minute) // and a tick three minutes after the last (the one at 20) still waits
	h.m.scan(ctx)
	assert.Equal(t, 5, delivered())
}

// #7915: the 15 s of slack is pinned from both sides: a tick up to 10 s early (the ticker's own jitter) still delivers, one 20 s early (a real shortfall) does not.
func TestCheckTickSlackIsAcceptedAndNoMore(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	hs := healthOn()
	hs.IntervalMin = 5
	_, err := h.s.UpdateBoardSettings(ctx, "team", board.BoardSettingsUpdate{Health: &hs})
	require.NoError(t, err)
	delivered := func() int { h.mu.Lock(); defer h.mu.Unlock(); return len(h.sent["Orchestrator"]) }

	tick := h.now
	h.m.scan(ctx)
	require.Equal(t, 1, delivered())
	h.now = tick.Add(5*time.Minute - 20*time.Second)
	h.m.scan(ctx)
	assert.Equal(t, 1, delivered(), "20 s early is a real shortfall: not delivered")
	h.now = tick.Add(5*time.Minute - 10*time.Second)
	h.m.scan(ctx)
	assert.Equal(t, 2, delivered(), "10 s early is the ticker's jitter: delivered")
	// the next check is scheduled from the tick that delivered, so jitter does not accumulate into a drift
	h.now = tick.Add(10*time.Minute - 10*time.Second - 20*time.Second)
	h.m.scan(ctx)
	assert.Equal(t, 2, delivered(), "20 s short of the interval after the last tick")
}
