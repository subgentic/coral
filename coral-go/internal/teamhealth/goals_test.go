package teamhealth

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #11412: the orchestrator's check lists the open goals, ready ones first, with what the operator has to do.
func TestGoalsAreListedReadyFirstThenTheOnesThatNeedTheOperator(t *testing.T) {
	line := goalsLine([]GoalLine{
		{ID: 3, Title: "Plain work", State: "active", Done: 1, Total: 4},
		{ID: 7, Title: "Needs a decision", State: "blocked", BlockedOn: "Operator picks an option", Driver: "Orchestrator", Done: 0, Total: 2, Remind: RemindOperator},
		{ID: 5, Title: "All done", State: "active", Done: 3, Total: 3, Remind: RemindClose},
	})
	assert.Less(t, strings.Index(line, "#5"), strings.Index(line, "#7"), "ready first")
	assert.Less(t, strings.Index(line, "#7"), strings.Index(line, "#3"), "then the operator's, then the rest")
	assert.Contains(t, line, `#5 "All done" 3/3 active READY: close it, or put an item in the operator's inbox`)
	assert.Contains(t, line, `#7 "Needs a decision" 0/2 blocked, in the goal's words: "Operator picks an option" (driver Orchestrator) NEEDS THE OPERATOR: put an item in their inbox`)
	assert.Contains(t, line, `#3 "Plain work" 1/4 active.`, "a goal that waits on the team is status only: nothing after its counts and state")
	assert.Contains(t, line, "coral-board goal close N", "how to close it")
	assert.Contains(t, line, `coral-board post --ask "@Operator goal N`, "how to put it in their inbox, naming the goal")
}

func TestNoReminderMeansNoLegendAndNoGoalsMeansNoSegment(t *testing.T) {
	assert.Equal(t, "", goalsLine(nil))
	line := goalsLine([]GoalLine{{ID: 1, Title: "A", State: "active", Done: 0, Total: 1}})
	assert.NotContains(t, line, "coral-board", "the how-to is said only where a reminder is")
	assert.Equal(t, `Goals: #1 "A" 0/1 active.`, line)
}

func TestTheGoalsSegmentHoldsEightGoalsAndCountsTheRestInsideItsBudget(t *testing.T) {
	var gs []GoalLine
	for i := 1; i <= 11; i++ {
		gs = append(gs, GoalLine{ID: int64(i), Title: strings.Repeat("long title ", 10), State: "active", Done: 1, Total: 2})
	}
	line := goalsLine(gs)
	assert.Equal(t, GoalsMax, strings.Count(line, `"long title`), "eight named")
	assert.Contains(t, line, "and 3 more")
	assert.NotContains(t, line, "#9 ")
	for i := 1; i <= 8; i++ {
		gs[i-1].Remind = RemindOperator
		gs[i-1].BlockedOn = strings.Repeat("Operator ", 30)
	}
	line = goalsLine(gs)
	assert.LessOrEqual(t, len(line), goalsBudget, "reminders and long reasons do not crowd the check out")
	assert.Contains(t, line, "more")
}

func TestAGoalsTitleAndReasonAreCleanedAndCut(t *testing.T) {
	hostile := "Ship @everyone\u200b now \x1b[31m" + strings.Repeat("x", 100)
	line := goalsLine([]GoalLine{{ID: 1, Title: hostile, State: "blocked", BlockedOn: "@Operator " + strings.Repeat("y", 200), Driver: "A\nB @all", Done: 0, Total: 1}})
	assert.NotContains(t, line, "@")
	assert.NotContains(t, line, "\x1b")
	assert.NotContains(t, line, "\u200b")
	assert.NotContains(t, line, "\n")
	assert.Contains(t, line, "(at)everyone", "an @ is neutralised, so a title cannot mention anyone")
	title := line[strings.Index(line, `"`)+1:]
	title = title[:strings.Index(title, `"`)]
	assert.LessOrEqual(t, len([]rune(title)), goalTitleMax, "about 50 characters")
}

func TestTheCheckSaysNoAgentNeedsYouWhileAGoalNeedsTheOperator(t *testing.T) {
	in := CheckInput{Now: time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC), Agents: 3, Progress: Progress{Since: time.Date(2026, 10, 31, 11, 50, 0, 0, time.UTC), Completed: 1}}
	plain := Compose(in)
	assert.NotContains(t, plain, "Goals:")
	in.Goals = []GoalLine{{ID: 4, Title: "Done", State: "active", Done: 2, Total: 2, Remind: RemindClose}}
	with := Compose(in)
	assert.Contains(t, with, "Goals: #4")
	in.Progress = Progress{Since: in.Progress.Since}
	assert.Contains(t, Compose(in), "No agent needs you;", "not Nothing needs you, with the operator needed")
	in.Goals = []GoalLine{{ID: 4, Title: "Active", State: "active", Done: 1, Total: 2}}
	assert.Contains(t, Compose(in), "Nothing needs you;", "a goal with no reminder changes nothing")
}

// QA's SHOULD on #11412: the roster form of the check says "No agent needs you" too, while a goal needs the operator.
func TestTheRosterCheckSaysNoAgentNeedsYouWhileAGoalNeedsTheOperator(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	in := CheckInput{Now: now, Roster: &Roster{Recipient: "Orchestrator", Counts: counts(3, 0, 0, 0, 0, 0)}, Progress: Progress{Since: now.Add(-10 * time.Minute), Posts: 5}}
	assert.Contains(t, Compose(in), "Nothing needs you.", "no goal: as before")
	in.Goals = []GoalLine{{ID: 4, Title: "Done", State: "active", Done: 2, Total: 2, Remind: RemindClose}}
	out := Compose(in)
	assert.Contains(t, out, "Goals: #4")
	assert.Contains(t, out, "No agent needs you.")
	assert.NotContains(t, out, "Nothing needs you")
	in.Goals = []GoalLine{{ID: 4, Title: "Active", State: "active", Done: 1, Total: 2}}
	assert.Contains(t, Compose(in), "Nothing needs you.", "a goal with no reminder changes nothing")
}

// A secret at the start of a title or of a blocked-on is redacted (QA's SHOULD on #11412).
func TestASecretAtTheStartOfAGoalsTitleOrReasonIsRedacted(t *testing.T) {
	const token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
	line := goalsLine([]GoalLine{{ID: 1, Title: token + " release", State: "blocked", BlockedOn: token + " decides", Done: 0, Total: 1}})
	assert.False(t, showsASecret(line), line)
	assert.NotContains(t, line, "A1b2C3d4")
}
