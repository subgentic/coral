package background

import (
	"context"
	"fmt"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// ruleGoalDoneNudge is the health rule that tells a goal's driver its tasks are all done (#12161). The Operator: "we are putting goals into the inbox to close out too quickly ... exploration has happened and more tasks
// haven't been added." A goal whose every task is done is the Operator's "Goal looks done" item only after a quiet period (the Needs you read, 15 minutes after its latest task completion); in that window the driver,
// or the Orchestrator when the goal has none, is told once so the next tasks can be added.
const ruleGoalDoneNudge = "goal-done-nudge"

// goalDoneNudgeText is the notice: a fixed template with the goal's number and the quiet period's minutes (a number the setting goal_done_quiet_minutes gave, never text): no title, no name is typed (Security's rule 1
// of the health nudges).
func goalDoneNudgeText(goalID int64, minutes int) string {
	return fmt.Sprintf("[Coral] Goal #%d's tasks are all done. Add the next tasks within %d minutes, or it goes to the Operator as done: coral-board task add \"...\" --goal %d", goalID, minutes, goalID)
}

// quiet is the quiet period the notice names: the setting's, 15 minutes when it is not read.
func (h *HealthNudges) quiet(ctx context.Context) time.Duration {
	if h.goalDoneQuiet != nil {
		return h.goalDoneQuiet(ctx)
	}
	return 15 * time.Minute
}

// nudgeGoalDone tells the driver (else the Orchestrator) of each active goal whose tasks became all done inside the quiet period, once for each all-done state (the key carries the goal's task total: more
// tasks, all done again, is a new state). Not when the goal has an open task, nobody running can be told, or the window is over (the goal is the Operator's then).
func (h *HealthNudges) nudgeGoalDone(ctx context.Context, project string, bySession map[string]AgentInfo, hs board.HealthSettings) {
	now := h.now()
	window := h.quiet(ctx)
	if window <= 0 {
		return // no quiet period: a goal that looks done is the Operator's at once, and there is no time to tell a driver
	}
	page, err := h.store.GoalPage(ctx, project, board.GoalListQuery{States: []string{board.GoalActive}, Limit: 100})
	if err != nil || len(page.Goals) == 0 {
		return
	}
	subs, err := h.store.ListSubscribers(ctx, project)
	if err != nil {
		return
	}
	orch, _ := h.store.TeamOrchestrator(ctx, project)
	r := &healthRun{h: h, project: project, hs: hs, now: now}
	for _, g := range page.Goals {
		if g.State != board.GoalActive || g.Rollup.Total == 0 || g.Rollup.Done != g.Rollup.Total || g.LooksDoneAt == nil {
			continue
		}
		doneAt, err := time.Parse(time.RFC3339Nano, *g.LooksDoneAt)
		if err != nil || now.Sub(doneAt) >= window || now.Before(doneAt.Add(-time.Minute)) {
			continue
		}
		key := fmt.Sprintf("%d|%d", g.ID, g.Rollup.Total)
		if done, _ := h.store.HealthActionTaken(ctx, project, ruleGoalDoneNudge+"-goal", key); done {
			continue // told once for this all-done state
		}
		who := g.Driver
		var sub *board.Subscriber
		for _, candidate := range []string{g.Driver, orch} { // the driver, else (or when the driver is not here) the Orchestrator
			if candidate == "" {
				continue
			}
			for i := range subs {
				if board.SameIdentity(subs[i].SubscriberID, candidate) && subs[i].IsActive != 0 {
					if _, live := bySession[subs[i].SessionName]; live {
						sub, who = &subs[i], candidate
					}
				}
			}
			if sub != nil {
				break
			}
		}
		if sub == nil {
			continue
		}
		a := bySession[sub.SessionName]
		if !r.take(ctx, ruleGoalDoneNudge, who, time.Minute) {
			continue
		}
		if sendUnlessBlocked(ctx, h.limit, h.deliver, a, fmt.Sprintf("health-goal-done:%s:%d", project, g.ID), goalDoneNudgeText(g.ID, int(window/time.Minute))) != nil {
			continue
		}
		_ = h.store.RecordHealthAction(ctx, project, ruleGoalDoneNudge+"-goal", key, now)
	}
}
