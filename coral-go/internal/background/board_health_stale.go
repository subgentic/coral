package background

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// The stale-task sweep (#14863, the Operator: "a periodic health monitor request that tells the orchestrator to clean up stale tasks and provides instructions on how to find them"). Every
// StaleSweepHours (a team setting, 12 by default, 0 off) the monitor types ONE message to the team's orchestrator, once the orchestrator is not in a turn, listing the candidates and the
// commands to look and to act. It never changes a task itself.
const (
	stalePendingAfter     = 3 * 24 * time.Hour // pending (not started) this long
	staleInProgressAfter  = 24 * time.Hour     // in progress this long, and the assignee has not posted
	staleReviewAfter      = 24 * time.Hour     // waiting in review this long
	staleSweepMaxPerGroup = 8                  // task numbers shown per group, the rest counted
)

type staleInput struct {
	Now        time.Time
	Open       []board.Task          // pending, in progress, blocked (ListOpenTaskStates)
	InReview   []board.Task          // tasks in review_pending (ListReviewStates, the parents only)
	Asleep     map[string]bool       // assignees whose session is asleep
	Gone       map[string]bool       // assignees with no live session (the CLI exited)
	LastPost   map[string]time.Time  // an assignee's latest board post
	GoalClosed map[int64]bool        // goals that are closed
	Parked     func(board.Task) bool // a parked task is set aside on purpose
	Title      func(string) string   // the one quoted line of agent text a title may be
}

func staleKey(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func (in staleInput) assignee(t board.Task) string {
	if t.AssignedTo == nil {
		return ""
	}
	return staleKey(*t.AssignedTo)
}

func staleAge(now time.Time, at string) (time.Duration, bool) {
	ts, ok := parseTime(at)
	if !ok {
		return 0, false
	}
	return now.Sub(ts), true
}

// staleSweepText is the sweep's message and how many tasks it names; "" and 0 when nothing is stale.
func staleSweepText(in staleInput) (string, int) {
	type group struct {
		title string
		ids   []int64
		lines []string
	}
	var pending, progress, review, asleep, gone, closed group
	pending.title = "Pending more than 3 days, never started"
	progress.title = "In progress more than a day with no post from the assignee"
	review.title = "Waiting in review more than a day"
	asleep.title = "Assigned to an agent that is asleep"
	gone.title = "Assigned to an agent whose CLI has exited"
	closed.title = "Open tasks of a goal that is closed"
	add := func(g *group, t board.Task) {
		g.ids = append(g.ids, t.ID)
		g.lines = append(g.lines, fmt.Sprintf("#%d %s", t.ID, in.Title(t.Title)))
	}
	named := map[int64]bool{}
	for _, t := range in.Open {
		if in.Parked != nil && in.Parked(t) {
			continue
		}
		who := in.assignee(t)
		switch {
		case t.GoalID != nil && in.GoalClosed[*t.GoalID]:
			add(&closed, t)
		case who != "" && in.Gone[who]:
			add(&gone, t)
		case who != "" && in.Asleep[who]:
			add(&asleep, t)
		case t.Status == "pending":
			if age, ok := staleAge(in.Now, t.CreatedAt); ok && age > stalePendingAfter {
				add(&pending, t)
			}
		case t.Status == "in_progress":
			since := t.CreatedAt
			if t.ClaimedAt != nil {
				since = *t.ClaimedAt
			}
			age, ok := staleAge(in.Now, since)
			if !ok || age <= staleInProgressAfter {
				continue
			}
			if last, posted := in.LastPost[who]; posted && in.Now.Sub(last) <= staleInProgressAfter {
				continue // it has posted today: not silent
			}
			add(&progress, t)
		}
	}
	for _, t := range in.InReview {
		if t.Status != "review_pending" {
			continue
		}
		since := t.CreatedAt
		if cr := t.Workflow.CompletionReview; cr != nil && cr.SubmittedAt != "" {
			since = cr.SubmittedAt
		}
		if age, ok := staleAge(in.Now, since); ok && age > staleReviewAfter {
			add(&review, t)
		}
	}
	groups := []*group{&pending, &progress, &review, &asleep, &gone, &closed}
	total := 0
	var parts []string
	for _, g := range groups {
		if len(g.ids) == 0 {
			continue
		}
		for _, id := range g.ids {
			if !named[id] {
				named[id] = true
				total++
			}
		}
		shown := g.lines
		more := ""
		if len(shown) > staleSweepMaxPerGroup {
			more = fmt.Sprintf(", and %d more: see coral-board task list", len(shown)-staleSweepMaxPerGroup)
			shown = shown[:staleSweepMaxPerGroup]
		}
		parts = append(parts, fmt.Sprintf("%s: %s%s", g.title, strings.Join(shown, "; "), more))
	}
	if total == 0 {
		return "", 0
	}
	text := fmt.Sprintf("[Coral stale-task sweep] %s · %s to look at. %s. Look first: coral-board task show N. Then decide, one task at a time: finished: coral-board task complete N --message \"what was done\"; with the wrong or a gone owner: coral-board task reassign N --to \"Name\"; not for now: coral-board task release N; its goal is closed: coral-board goal close or move the task to another goal; not needed any more: coral-board task cancel N --message \"why\". Coral changed nothing; this message comes every few hours, as the team's health settings say.",
		in.Now.UTC().Format("15:04Z"), teamhealthPlural(total, "task", "tasks"), strings.Join(parts, ". "))
	if len(text) > teamhealth.MaxCheck {
		text = strings.ToValidUTF8(text[:teamhealth.MaxCheck], "")
	}
	return text, total
}

// sweepProject sends the board's stale-task sweep to its orchestrator when it is due (every StaleSweepHours), the orchestrator is live and not in a turn, and something is stale. A board with
// its health check off, or the setting off, or paused, gets none. The clock starts at the first look, so a restart does not send one at once only to find the same tasks again.
func (m *BoardHealthMonitor) sweepProject(ctx context.Context, project string, bySession map[string]AgentInfo, tick time.Time) {
	hs := m.store.GetHealthSettings(ctx, project)
	if !hs.On || hs.StaleSweepHours <= 0 {
		return
	}
	if m.paused != nil && m.paused(project) {
		return
	}
	m.mu.Lock()
	last, seen := m.lastSweep[project]
	if !seen {
		m.lastSweep[project] = tick
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()
	if tick.Sub(last)+tickSlack < time.Duration(hs.StaleSweepHours)*time.Hour {
		return
	}
	orch, err := m.store.TeamOrchestrator(ctx, project)
	if err != nil {
		return
	}
	sub, err := m.store.GetProjectSubscription(ctx, project, orch)
	if err != nil || sub == nil {
		return
	}
	agent, live := bySession[sub.SessionName]
	if !live {
		return
	}
	if m.signal != nil {
		if sig, ok := m.signal(ctx, agent.SessionID); ok && sig.InTurn {
			return // not mid-turn: it comes at the next scan, when the orchestrator is idle or waiting
		}
	}
	open, err := m.store.ListOpenTaskStates(ctx, project)
	if err != nil {
		return
	}
	all, _ := m.store.ListReviewStates(ctx, project)
	var inReview []board.Task
	for _, t := range all {
		if t.Status == "review_pending" && t.Workflow.ReviewOf == 0 {
			inReview = append(inReview, t)
		}
	}
	subs, err := m.store.ListSubscribers(ctx, project)
	if err != nil {
		return
	}
	asleep, _ := m.store.SleepingSubscribers(ctx, project)
	in := staleInput{Now: tick, Open: open, InReview: inReview, Asleep: map[string]bool{}, Gone: map[string]bool{}, LastPost: map[string]time.Time{}, GoalClosed: map[int64]bool{},
		Title: func(s string) string { return teamhealth.ShownText(s, nil) }}
	for _, s := range subs {
		key := staleKey(s.SubscriberID)
		if asleep[s.SubscriberID] {
			in.Asleep[key] = true
		} else if _, live := bySession[s.SessionName]; !live {
			in.Gone[key] = true
		}
		if _, at, err := m.store.LastPostBy(ctx, project, s.SubscriberID); err == nil && !at.IsZero() {
			in.LastPost[key] = at
		}
	}
	goals := map[int64]bool{}
	for _, t := range open {
		if t.GoalID != nil && !goals[*t.GoalID] {
			goals[*t.GoalID] = true
			if g, err := m.store.GetGoal(ctx, project, *t.GoalID); err == nil && g != nil && g.ClosedAt != nil {
				in.GoalClosed[*t.GoalID] = true
			}
		}
	}
	in.Parked = func(t board.Task) bool { return t.Parked(tick) }
	text, n := staleSweepText(in)
	if n == 0 { // nothing stale means nothing is sent until the next period
		m.mu.Lock()
		m.lastSweep[project] = tick
		m.mu.Unlock()
		return
	}
	if err := sendUnlessBlocked(ctx, m.limit, m.deliver, agent, "stale-sweep:"+project, text); err != nil {
		m.logger.Warn("stale-task sweep delivery failed: it is tried again at the next scan", "project", project, "error", err) // the clock is not restarted: a failed or blocked delivery is retried next tick, not a whole period later (#15354, QA's SHOULD on #14863)
		return
	}
	m.mu.Lock()
	m.lastSweep[project] = tick
	m.mu.Unlock()
}
