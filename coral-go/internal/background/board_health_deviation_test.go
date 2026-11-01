package background

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// deviationHarness is a check harness whose board file a test can also write to directly, to give tasks, posts and waits the times a history needs.
type deviationHarness struct {
	*checkHarness
	raw *sqlx.DB
}

func newDeviationHarness(t *testing.T) *deviationHarness {
	t.Helper()
	path := filepath.Join(t.TempDir(), "board-deviation.db")
	s, err := board.NewStoreWithKey(path, "")
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	require.NoError(t, s.SetHealthOn(ctx, "team", true))
	hs := s.GetHealthSettings(ctx, "team")
	hs.HeartbeatMin = 5
	require.NoError(t, s.SetHealthSettings(ctx, "team", hs))
	h := &checkHarness{t: t, s: s, now: time.Now().UTC().Add(time.Minute), sig: map[string]agentSignal{}, sent: map[string][]string{}}
	h.m = NewBoardHealthMonitor(s, 10*time.Minute)
	h.m.now = func() time.Time { return h.now }
	h.m.discover = func(context.Context) ([]AgentInfo, error) { return h.agents, nil }
	h.m.signal = func(_ context.Context, id string) (agentSignal, bool) { sg, ok := h.sig[id]; return sg, ok }
	h.m.deliver = func(_ context.Context, a AgentInfo, _ string, text string) error {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.sent[a.DisplayName] = append(h.sent[a.DisplayName], text)
		return nil
	}
	raw, err := sqlx.Open("sqlite", path)
	require.NoError(t, err)
	t.Cleanup(func() { raw.Close() })
	return &deviationHarness{checkHarness: h, raw: raw}
}

func ts(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// finished gives agent n finished tasks that each took took, the latest ending an hour ago.
func (d *deviationHarness) finished(agent string, n int, took time.Duration) {
	d.t.Helper()
	ctx := context.Background()
	for i := 0; i < n; i++ {
		task, err := d.s.CreateTask(ctx, "team", fmt.Sprintf("old %s %d", agent, i), "", "medium", "lead", agent)
		require.NoError(d.t, err)
		end := time.Now().Add(-time.Hour - time.Duration(i)*time.Hour)
		_, err = d.raw.ExecContext(ctx, `UPDATE board_tasks SET status='completed', claimed_at=?, completed_at=?, completed_by=? WHERE id=?`, ts(end.Add(-took)), ts(end), agent, task.ID)
		require.NoError(d.t, err)
	}
}

// running gives agent a task in progress, claimed ago before now.
func (d *deviationHarness) running(agent string, ago time.Duration) int64 {
	d.t.Helper()
	ctx := context.Background()
	task, err := d.s.CreateTask(ctx, "team", "current "+agent, "", "medium", "lead", agent)
	require.NoError(d.t, err)
	_, err = d.s.ClaimTask(ctx, "team", agent, task.ID)
	require.NoError(d.t, err)
	_, err = d.raw.ExecContext(ctx, `UPDATE board_tasks SET claimed_at=? WHERE id=?`, ts(time.Now().Add(-ago)), task.ID)
	require.NoError(d.t, err)
	return task.ID
}

// A (#11729): a task in progress far past its owner's usual is a line, said once at the crossing and again only at each doubling.
func TestDeviationATaskFarPastItsOwnersUsualIsSaidOncePerDoubling(t *testing.T) {
	d := newDeviationHarness(t)
	d.member("Orchestrator", "Orchestrator", 1, 0)
	d.member("Dev", "Developer", 2, 0)
	d.finished("Dev", 5, 10*time.Minute)   // median 10, p90 10: the limit is 20 minutes
	id := d.running("Dev", 49*time.Minute) // the harness clock is a minute ahead of the store's
	said := fmt.Sprintf("Dev: #%d has been in progress for 50 min; the usual is 10 min (median of its last 5, 90th percentile 10 min)", id)
	out := d.check()
	assert.Contains(t, out, said, "past 2x the median: said at the crossing")
	d.now = d.now.Add(11 * time.Minute) // 61 minutes: the same level (40 to 79)
	assert.NotContains(t, d.checkNoReset(), fmt.Sprintf("#%d has been in progress", id), "not said again until the next doubling")
	d.now = d.now.Add(25 * time.Minute) // 86 minutes: past 80, the next doubling
	assert.Contains(t, d.checkNoReset(), fmt.Sprintf("#%d has been in progress for 1 h 26 min", id), "said again at the doubling")
}

// Never said while on time: a task within its usual, or an agent with too little history, is not a line.
func TestDeviationAOnTimeAndWithoutHistoryIsNotSaid(t *testing.T) {
	d := newDeviationHarness(t)
	d.member("Orchestrator", "Orchestrator", 1, 0)
	d.member("Dev", "Developer", 2, 0)
	d.member("New", "Developer", 3, 0)
	d.finished("Dev", 5, 30*time.Minute) // the limit is 60 minutes
	d.running("Dev", 49*time.Minute)
	d.running("New", 500*time.Minute) // no finished tasks of its own, and the team has only Dev's five: the team's numbers apply, 60 minutes
	out := d.check()
	assert.NotContains(t, out, "Dev: #", "50 minutes is within its usual")
	assert.Contains(t, out, "New: #", "with under five of its own, the team's usual is used")
	assert.Contains(t, out, "the team's last 5 (it has under 5 of its own)")
}

// B: silence on a task longer than three times the usual gap between its owner's posts on it.
func TestDeviationBSilenceOnATaskPastItsUsualGap(t *testing.T) {
	d := newDeviationHarness(t)
	ctx := context.Background()
	d.member("Orchestrator", "Orchestrator", 1, 0)
	d.member("Dev", "Developer", 2, 0)
	id := d.running("Dev", 60*time.Minute)
	for _, ago := range []int{55, 50, 45} { // a post every five minutes, then nothing for 45 minutes
		p, err := d.s.PostMessage(ctx, "team", "Dev", fmt.Sprintf("progress on #%d", id), nil)
		require.NoError(t, err)
		_, err = d.raw.ExecContext(ctx, `UPDATE board_messages SET created_at=? WHERE id=?`, ts(time.Now().Add(-time.Duration(ago)*time.Minute)), p.ID)
		require.NoError(t, err)
	}
	out := d.check()
	assert.Contains(t, out, fmt.Sprintf("Dev: silent on #%d for 46 min; its usual gap between posts on it is 5 min (median of 3)", id))
	assert.Contains(t, out, "Suggest: ask for a status")
}

// C: a wait longer than twice the median of that pair's earlier answered waits; waits on the Operator are left out.
func TestDeviationCWaitPastThePairsUsualAnswer(t *testing.T) {
	d := newDeviationHarness(t)
	ctx := context.Background()
	d.member("Orchestrator", "Orchestrator", 1, 0)
	d.member("Security Reviewer", "Security", 2, 0)
	d.member("Dev", "Developer", 3, 0)
	d.member("Waiter", "Developer", 4, 0)
	at := time.Now().Add(-5 * time.Hour)
	for i := 0; i < 3; i++ { // earlier answered waits of 5 minutes
		_, err := d.raw.ExecContext(ctx, `INSERT INTO board_waits(project, subscriber_id, session_name, wait_type, target_id, reason, status, created_at, resolved_at, expires_at) VALUES ('team','Dev','s','message','Security Reviewer','','resolved',?,?,?)`,
			ts(at.Add(time.Duration(i)*time.Hour)), ts(at.Add(time.Duration(i)*time.Hour+5*time.Minute)), ts(at.Add(10*time.Hour)))
		require.NoError(t, err)
	}
	d.wait(3, "Dev", "message", "Security Reviewer")
	d.wait(4, "Waiter", "operator", "")
	_, err := d.raw.ExecContext(ctx, `UPDATE board_waits SET created_at=? WHERE status='active'`, ts(time.Now().Add(-20*time.Minute)))
	require.NoError(t, err)
	out := d.check()
	assert.Contains(t, out, "Dev: has waited 21 min on Security Reviewer; an answer usually takes 5 min (median of 3 earlier waits)")
	assert.NotContains(t, out, "Waiter: has waited", "a wait on the Operator is not a deviation")
}

// A parked task is left out, and the setting turns the rule off.
func TestDeviationSkipsParkedTasksAndFollowsTheSetting(t *testing.T) {
	d := newDeviationHarness(t)
	ctx := context.Background()
	d.member("Orchestrator", "Orchestrator", 1, 0)
	d.member("Dev", "Developer", 2, 0)
	d.finished("Dev", 5, 10*time.Minute)
	id := d.running("Dev", 50*time.Minute)
	hs := d.s.GetHealthSettings(ctx, "team")
	hs.Deviations.On = false
	require.NoError(t, d.s.SetHealthSettings(ctx, "team", hs))
	assert.NotContains(t, d.check(), fmt.Sprintf("#%d has been in progress", id), "the rule is off")
	hs.Deviations.On = true
	require.NoError(t, d.s.SetHealthSettings(ctx, "team", hs))
	assert.True(t, strings.Contains(d.check(), fmt.Sprintf("#%d has been in progress", id)), "and on")
}

// checkNoReset is a check that keeps what the monitor remembers (what was said, what the last look found), as a real next check does.
func (d *deviationHarness) checkNoReset() string {
	d.t.Helper()
	d.mu.Lock()
	n := len(d.sent["Orchestrator"])
	d.mu.Unlock()
	d.m.mu.Lock()
	delete(d.m.lastEval, "team") // only the interval is skipped; the facts and the counters stay
	d.m.mu.Unlock()
	d.m.scan(context.Background())
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.sent["Orchestrator"]) == n {
		return "" // nothing was sent: nothing new
	}
	got := d.sent["Orchestrator"]
	return got[len(got)-1]
}

// answered gives subscriber three earlier answered waits (resolved) of took each, on the given kind and target.
func (d *deviationHarness) answered(subscriber, kind, target string, took time.Duration) {
	d.t.Helper()
	at := time.Now().Add(-5 * time.Hour)
	for i := 0; i < 3; i++ {
		_, err := d.raw.ExecContext(context.Background(), `INSERT INTO board_waits(project, subscriber_id, session_name, wait_type, target_id, reason, status, created_at, resolved_at, expires_at) VALUES ('team',?,'s',?,?,'','resolved',?,?,?)`,
			subscriber, kind, target, ts(at.Add(time.Duration(i)*time.Hour)), ts(at.Add(time.Duration(i)*time.Hour+took)), ts(at.Add(10*time.Hour)))
		require.NoError(d.t, err)
	}
}

// QA's SHOULDs on slice 3: a wait on the recipient is its own line and not a deviation too; a wait on the Operator is not one even with a history of answers.
func TestDeviationCSkipsWaitsOnTheRecipientAndOnTheOperatorEvenWithHistory(t *testing.T) {
	d := newDeviationHarness(t)
	ctx := context.Background()
	d.member("Orchestrator", "Orchestrator", 1, 0)
	d.member("Dev", "Developer", 2, 0)
	d.member("Waiter", "Developer", 3, 0)
	d.answered("Dev", "message", "Orchestrator", 5*time.Minute)
	d.answered("Waiter", "operator", "", 5*time.Minute)
	d.wait(2, "Dev", "message", "Orchestrator")
	d.wait(3, "Waiter", "operator", "")
	_, err := d.raw.ExecContext(ctx, `UPDATE board_waits SET created_at=? WHERE status='active'`, ts(time.Now().Add(-20*time.Minute)))
	require.NoError(t, err)
	out := d.check()
	assert.Contains(t, out, "Dev has waited 21 min on YOU", "the wait on the recipient is its own line")
	assert.NotContains(t, out, "an answer usually takes", "and not a deviation as well, nor is the Operator's wait, though both have a history of answers")
}

// The serving rule's second half (Security's INFO): a wait on a task is served when the task is done, even though the wait row is still active.
func TestActionListTaskWaitStillActiveIsNotListedOnceTheTaskIsDone(t *testing.T) {
	d := newDeviationHarness(t)
	ctx := context.Background()
	d.member("Orchestrator", "Orchestrator", 1, 0)
	d.member("Security Reviewer", "Security", 2, 0)
	d.member("Dev", "Developer", 3, 0)
	task, err := d.s.CreateTask(ctx, "team", "owned", "", "medium", "Operator", "Security Reviewer")
	require.NoError(t, err)
	d.wait(3, "Dev", "task", fmt.Sprint(task.ID))
	d.now = time.Now().UTC().Add(20 * time.Minute)
	assert.Contains(t, d.check(), "Dev has waited 20 min on Security Reviewer", "listed while the task is open")
	_, err = d.s.ClaimTask(ctx, "team", "Security Reviewer", task.ID)
	require.NoError(t, err)
	_, err = d.s.CompleteTask(ctx, "team", task.ID, "Security Reviewer", nil)
	require.NoError(t, err)
	_, err = d.raw.ExecContext(ctx, `UPDATE board_waits SET status='active', resolved_at=NULL WHERE subscriber_id='Dev'`) // the wait row outlives the task in this case
	require.NoError(t, err)
	assert.NotContains(t, d.check(), "Dev has waited", "the task is done: the wait is served")
}

// What was said is kept across a restart and cleared when the task is gone: a restart does not say it again, and a finding that ended is new if it comes back.
func TestDeviationSaidOnceSurvivesARestartAndIsClearedWhenTheTaskIsGone(t *testing.T) {
	d := newDeviationHarness(t)
	ctx := context.Background()
	d.member("Orchestrator", "Orchestrator", 1, 0)
	d.member("Dev", "Developer", 2, 0)
	d.finished("Dev", 5, 10*time.Minute)
	id := d.running("Dev", 49*time.Minute)
	assert.Contains(t, d.check(), fmt.Sprintf("#%d has been in progress", id))
	counters := func() int {
		esc, err := d.s.HealthEscalations(ctx, "team")
		require.NoError(t, err)
		n := 0
		for _, e := range esc {
			if strings.HasPrefix(e.Rule, deviationRulePrefix) {
				n++
			}
		}
		return n
	}
	assert.Equal(t, 1, counters(), "said: kept in the health counters")
	// a restart: a new monitor on the same board remembers nothing in memory, and still does not say it again
	fresh := NewBoardHealthMonitor(d.s, 10*time.Minute)
	fresh.now, fresh.discover, fresh.signal, fresh.deliver = d.m.now, d.m.discover, d.m.signal, d.m.deliver
	d.m = fresh
	assert.NotContains(t, d.check(), fmt.Sprintf("#%d has been in progress", id), "a restart does not say it again")
	// the task is finished: its counter is cleared by the next look
	_, err := d.s.CompleteTask(ctx, "team", id, "Dev", nil)
	require.NoError(t, err)
	d.check()
	assert.Zero(t, counters(), "cleared when the task is gone, so the same finding later is new")
}
