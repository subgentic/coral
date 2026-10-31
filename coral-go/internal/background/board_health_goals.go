package background

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// The orchestrator's check lists the board's open goals and reminds it of those the operator has to look at (#11412): a goal whose every task is done, a goal blocked on the Operator, a goal whose done-when
// names the Operator and has no task left to do. The reminder is repeated on every check until an open ask to the Operator names the goal ("goal 92", the words post --ask is told to use) or the goal is
// closed, which takes it off the list. Goals and counts are the board's own; a goal's title, its blocked-on and its driver go through the check's sanitizer when they are shown (teamhealth/goals.go).

// operatorWord is a text that names the Operator.
var operatorWord = regexp.MustCompile(`(?i)\boperator\b`)

// goalLines is the open goals as the check shows them, and how many of them carry a reminder.
func (m *BoardHealthMonitor) goalLines(ctx context.Context, project string, now time.Time) ([]teamhealth.GoalLine, int) {
	goals, err := m.store.ListGoals(ctx, project, board.GoalListQuery{Limit: 100})
	if err != nil || len(goals) == 0 {
		return nil, 0
	}
	asked := m.operatorAskedGoals(ctx, project, now)
	lines := make([]teamhealth.GoalLine, 0, len(goals))
	reminders := 0
	for _, g := range goals {
		l := teamhealth.GoalLine{ID: g.ID, Title: g.Title, State: g.State, BlockedOn: g.BlockedOn, Driver: g.Driver, Done: g.Rollup.Done, Total: g.Rollup.Total}
		ready := g.Rollup.Total > 0 && g.Rollup.Done == g.Rollup.Total
		noTaskLeft := g.Rollup.Total == g.Rollup.Done // nothing the team still has to do, with or without tasks
		blockedOnOperator := g.State == board.GoalBlocked && operatorWord.MatchString(g.BlockedOn)
		doneWhenNeedsOperator := operatorWord.MatchString(g.DoneWhen) && noTaskLeft
		switch {
		case asked[g.ID]:
			// an open ask to the Operator names it: it is in their inbox
		case ready:
			l.Remind = teamhealth.RemindClose
		case blockedOnOperator || doneWhenNeedsOperator:
			l.Remind = teamhealth.RemindOperator
		}
		if l.Remind != teamhealth.RemindNone {
			reminders++
		}
		lines = append(lines, l)
	}
	return lines, reminders
}

// operatorAskedGoals is the goals an open ask to the Operator names: an unanswered post --ask to the Operator, or an active wait for the Operator's reply.
func (m *BoardHealthMonitor) operatorAskedGoals(ctx context.Context, project string, now time.Time) map[int64]bool {
	out := map[int64]bool{}
	if open, err := m.store.OpenAsks(ctx, project, now); err == nil {
		for _, a := range open {
			if strings.EqualFold(a.Member, "Operator") {
				for _, id := range board.GoalsNamedIn(a.Content) {
					out[id] = true
				}
			}
		}
	}
	if qs, err := m.store.ListOperatorQuestions(ctx, project); err == nil {
		for _, q := range qs {
			for _, id := range board.GoalsNamedIn(q.Reason) {
				out[id] = true
			}
		}
	}
	return out
}
