package background

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #11412: the orchestrator's check lists the open goals and reminds it of the ones the operator has to look at, until an open ask to the Operator names the goal or the goal is closed.

func newGoalsRig(t *testing.T) *readyRig {
	r := newReadyRig(t)
	r.member("Lead", "Lead Developer", 3, 0)
	_, err := r.s.Subscribe(context.Background(), "team", "Operator", "Operator", "", nil, "all") // the operator reads the board without an agent
	require.NoError(t, err)
	return r
}

// askOperator posts a question to the Operator, as post --ask does.
func (r *readyRig) askOperator(text string) {
	r.t.Helper()
	ctx := context.Background()
	q, err := r.s.PostMessage(ctx, "team", "Lead", text, nil)
	require.NoError(r.t, err)
	to, err := r.s.AskTargets(ctx, "team", "Lead", q.Content)
	require.NoError(r.t, err)
	require.NoError(r.t, r.s.RecordAsk(ctx, "team", q, to))
}

func (r *readyRig) blockedGoal(title, blockedOn string, tasks int) int64 {
	r.t.Helper()
	ctx := context.Background()
	g, err := r.s.CreateGoal(ctx, "team", board.GoalInput{Title: title, Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(r.t, err)
	for i := 0; i < tasks; i++ {
		_, err := r.s.CreateTaskWithOpts(ctx, "team", "still going", "", "medium", "Operator", &board.CreateTaskOpts{GoalID: &g.ID}, "Dev")
		require.NoError(r.t, err)
	}
	st, on := board.GoalBlocked, blockedOn
	_, err = r.s.UpdateGoal(ctx, "team", g.ID, board.GoalUpdate{State: &st, BlockedOn: &on})
	require.NoError(r.t, err)
	return g.ID
}

func goalsSegment(check string) string {
	for _, l := range strings.Split(check, " • ") {
		if strings.HasPrefix(l, "Goals: ") {
			return l
		}
	}
	return ""
}

func TestADoneGoalIsNamedWithItsReminderUntilAnAskToTheOperatorNamesIt(t *testing.T) {
	r := newGoalsRig(t)
	g := r.goalDone("Release 2.0.11", 2)
	seg := goalsSegment(r.next())
	require.NotEmpty(t, seg, "the orchestrator's check lists the open goals")
	assert.Contains(t, seg, fmt.Sprintf(`#%d "Release 2.0.11" 2/2`, g))
	assert.Contains(t, seg, "READY: close it, or put an item in the operator's inbox")
	assert.Contains(t, goalsSegment(r.next()), "READY", "repeated on each check")

	r.askOperator(fmt.Sprintf("@Operator goal %d: please check the notes and say if it can close", g))
	seg = goalsSegment(r.next())
	assert.Contains(t, seg, fmt.Sprintf("#%d", g), "still an open goal")
	assert.NotContains(t, seg, "READY", "an open ask to the Operator names it: it is in their inbox, so the reminder stops")
	assert.NotContains(t, seg, "NEEDS THE OPERATOR")

	_, _, err := r.s.CloseGoal(context.Background(), "team", g, "met", board.GoalDone)
	require.NoError(t, err)
	assert.NotContains(t, r.next(), fmt.Sprintf("#%d \"Release", g), "a closed goal is not listed")
}

func TestAnAskThatDoesNotNameTheGoalInWordsDoesNotStopTheReminder(t *testing.T) {
	r := newGoalsRig(t)
	g := r.goalDone("Finish", 1)
	r.askOperator(fmt.Sprintf("@Operator see #%d and task %d", g, g)) // a bare #N is as likely a task
	assert.Contains(t, goalsSegment(r.next()), "READY")
	r.askOperator(fmt.Sprintf("@Operator goals 99 and #%d: please check", g))
	assert.NotContains(t, goalsSegment(r.next()), "READY", "named in a list of goals")
}

func TestAGoalBlockedOnTheOperatorOrWithADoneWhenThatNeedsThemIsNamedAndOneWaitingOnAnAgentIsNot(t *testing.T) {
	r := newGoalsRig(t)
	ctx := context.Background()
	op := r.blockedGoal("Needs a pick", "Operator picks an option from the design", 1)
	agent := r.blockedGoal("Waits on Backend", "Backend Dev finishing the opencode run", 1)
	// done-when names the Operator, and no task is left: it is theirs to confirm
	g, err := r.s.CreateGoal(ctx, "team", board.GoalInput{Title: "Operator signs off", Outcome: "o", DoneWhen: "The operator says it is good", CreatedBy: "Operator"})
	require.NoError(t, err)
	// the same done-when with a task still open: the team has work to do first
	busy, err := r.s.CreateGoal(ctx, "team", board.GoalInput{Title: "Busy", Outcome: "o", DoneWhen: "The operator says it is good", CreatedBy: "Operator"})
	require.NoError(t, err)
	_, err = r.s.CreateTaskWithOpts(ctx, "team", "work", "", "medium", "Operator", &board.CreateTaskOpts{GoalID: &busy.ID}, "Dev")
	require.NoError(t, err)

	seg := goalsSegment(r.next())
	entry := func(id int64) string {
		start := strings.Index(seg, fmt.Sprintf("#%d ", id))
		require.GreaterOrEqual(t, start, 0, "goal %d listed", id)
		end := strings.Index(seg[start:], "; ")
		if end < 0 {
			end = len(seg) - start
		}
		return seg[start : start+end]
	}
	assert.Contains(t, entry(op), "NEEDS THE OPERATOR: put an item in their inbox")
	assert.Contains(t, entry(op), "blocked: Operator picks an option from the design")
	assert.Contains(t, entry(g.ID), "NEEDS THE OPERATOR", "a done-when that names the Operator, with nothing left for the team")
	assert.NotContains(t, entry(agent), "NEEDS THE OPERATOR", "waiting on an agent")
	assert.NotContains(t, entry(agent), "READY")
	assert.NotContains(t, entry(busy.ID), "NEEDS THE OPERATOR", "the team still has a task to do")
}

func TestOnlyTheOrchestratorsCheckCarriesTheGoals(t *testing.T) {
	r := newGoalsRig(t)
	r.goalDone("Release", 1)
	ctx := context.Background()
	dev, err := r.s.GetProjectSubscription(ctx, "team", "Dev")
	require.NoError(t, err)
	text, _, err := r.m.composeCheck(ctx, "team", "Orchestrator", dev, map[string]AgentInfo{})
	require.NoError(t, err)
	assert.NotContains(t, text, "Goals:", "the check is the orchestrator's: it is the one who closes goals and reaches the operator")
	orch, err := r.s.GetProjectSubscription(ctx, "team", "Orchestrator")
	require.NoError(t, err)
	text, _, err = r.m.composeCheck(ctx, "team", "Orchestrator", orch, map[string]AgentInfo{})
	require.NoError(t, err)
	assert.Contains(t, text, "Goals:")
}

func TestAReminderAloneMakesTheCheckGoOutAndTitlesAreCleaned(t *testing.T) {
	r := newGoalsRig(t)
	r.goalDone("Ship @everyone\u200b now", 1)
	out := r.next()
	seg := goalsSegment(out)
	entry := seg[:strings.Index(seg, " READY")] // the goal's own words; the how-to after it is Coral's and names @Operator on purpose
	assert.NotContains(t, entry, "@", "an @ in a title cannot mention anyone")
	assert.NotContains(t, entry, "\u200b")
	assert.Contains(t, entry, "(at)everyone")
	_, count, err := r.m.composeCheck(context.Background(), "team", "Orchestrator", mustSub(t, r, "Orchestrator"), map[string]AgentInfo{})
	require.NoError(t, err)
	assert.Greater(t, count, 0, "a goal reminder counts as something that needs the orchestrator, so the check is sent")
}

func mustSub(t *testing.T, r *readyRig, name string) *board.Subscriber {
	t.Helper()
	s, err := r.s.GetProjectSubscription(context.Background(), "team", name)
	require.NoError(t, err)
	return s
}
