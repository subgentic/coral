package background

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// Deviations from a member's own history (#11729 slice 3, coral-hub's operator), from the board's own records:
//   A. a task in progress longer than max(2 x the median, the 90th percentile) of its owner's last ~30 claimed-to-completed times (the team's numbers when it has under 5);
//   B. silence on a task longer than 3 x the usual gap between its owner's posts on it (its claim and posts naming #N);
//   C. a wait longer than 2 x the median of that pair's earlier answered waits.
// Each is flagged once when it crosses its threshold and again only at each doubling, never while on time; parked tasks, waits on the Operator and waits on the check's recipient (a line of their own) are
// left out. What was said is kept in the health counters (rule "deviation-<kind>-<level>"), so a restart does not say it again, and cleared when the task or wait is gone.

// deviationRulePrefix names the counters.
const deviationRulePrefix = "deviation-"

// deviationSaid is a finding composed into a check, kept until the check is delivered with it.
type deviationSaid struct {
	rule, target, subject, needle string
}

// deviationItems returns the findings not said yet at their current level, and notes them to be marked said once a check has been delivered with them.
func (m *BoardHealthMonitor) deviationItems(ctx context.Context, project string, rcpt *board.Subscriber, tasks []board.Task, parked map[string]bool, waits []board.RegisteredWait, subs []board.Subscriber, now time.Time) []teamhealth.Item {
	if !m.store.GetHealthSettings(ctx, project).Deviations.On {
		return nil
	}
	hist, err := m.store.ClaimToDoneDurations(ctx, project)
	if err != nil {
		return nil
	}
	var team []time.Duration
	for _, ds := range hist {
		team = append(team, ds...)
	}
	live := map[string]bool{} // "<kind>|<id>" of everything still going on, so what is gone is cleared
	var items []teamhealth.Item
	var pending []deviationSaid
	flag := func(kind, id, agent string, level int, it teamhealth.Item) {
		subject := kind + "|" + id
		live[subject] = true
		if level <= 0 {
			return
		}
		rule := fmt.Sprintf("%s%s-%d", deviationRulePrefix, strings.ToLower(kind), level)
		if c, err := m.store.GetHealthCounter(ctx, project, rule, agent, subject); err != nil || c.Escalated {
			return // said at this level already
		}
		it.Rank = 3
		it.Key = "deviation|" + subject + "|" + agent
		it.State = fmt.Sprint(level)
		items = append(items, it)
		pending = append(pending, deviationSaid{rule: rule, target: agent, subject: subject, needle: "[ack " + teamhealth.ItemID(it.Key) + "]"})
	}
	for _, t := range tasks {
		if t.Status != "in_progress" || t.AssignedTo == nil || t.ClaimedAt == nil || parked[fmt.Sprint(t.ID)] {
			continue
		}
		claimed, err := time.Parse(time.RFC3339, *t.ClaimedAt)
		if err != nil {
			continue
		}
		agent, name := *t.AssignedTo, teamhealth.Name(*t.AssignedTo)
		id := fmt.Sprint(t.ID)
		age := now.Sub(claimed)
		// A: longer than its owner's usual
		if u, ok := teamhealth.UsualTaskTime(hist[agent], team); ok {
			whose := fmt.Sprintf("its last %d", u.N)
			if u.Team {
				whose = fmt.Sprintf("the team's last %d (it has under %d of its own)", u.N, teamhealth.MinOwnSamples)
			}
			flag("A", id, agent, teamhealth.Level(age, u.TaskOverdue()), teamhealth.Item{Agent: name, Age: age,
				Problem: fmt.Sprintf("#%d has been in progress for %s; the usual is %s (median of %s, 90th percentile %s)", t.ID, teamhealth.Age(age), teamhealth.Age(u.Median), whose, teamhealth.Age(u.P90)),
				Suggest: "check on it"})
		}
		// B: silent longer than its usual gap between posts
		events := []time.Time{claimed}
		if posts, err := m.store.TaskPostTimes(ctx, project, agent, t.ID, claimed); err == nil {
			events = append(events, posts...)
		}
		var gaps []time.Duration
		for i := 1; i < len(events); i++ {
			gaps = append(gaps, events[i].Sub(events[i-1]))
		}
		if len(gaps) >= teamhealth.MinGapSamples {
			usual := teamhealth.Median(gaps)
			silent := now.Sub(events[len(events)-1])
			flag("B", id, agent, teamhealth.Level(silent, 3*usual), teamhealth.Item{Agent: name, Age: silent,
				Problem: fmt.Sprintf("silent on #%d for %s; its usual gap between posts on it is %s (median of %d)", t.ID, teamhealth.Age(silent), teamhealth.Age(usual), len(gaps)),
				Suggest: "ask for a status"})
		}
	}
	taskByID := map[string]board.Task{}
	for _, t := range tasks {
		taskByID[fmt.Sprint(t.ID)] = t
	}
	for _, w := range waits {
		if w.WaitType == board.WaitOperator {
			continue
		}
		if w.WaitType == "task" && parked[w.TargetID] {
			continue
		}
		at, err := time.Parse(time.RFC3339, w.CreatedAt)
		if err != nil {
			continue
		}
		target := resolveWait(w, subs, taskByID2(taskByID))
		if m.inQueueWait(w, target) {
			continue // in a resource line behind the party it waits on: the line moving is the answer (#13707)
		}
		on := target.label
		if target.sub != nil {
			if rcpt != nil && board.SameIdentity(target.sub.SubscriberID, rcpt.SubscriberID) {
				continue // a wait on the recipient is a line of its own
			}
			on = teamhealth.Name(target.sub.SubscriberID)
		}
		prior, err := m.store.ResolvedWaitDurations(ctx, project, w.SubscriberID, w.WaitType, w.TargetID, 30)
		if err != nil || len(prior) < teamhealth.MinWaitSamples {
			continue
		}
		usual := teamhealth.Median(prior)
		age := now.Sub(at)
		flag("C", fmt.Sprint(w.ID), w.SubscriberID, teamhealth.Level(age, 2*usual), teamhealth.Item{Agent: teamhealth.Name(w.SubscriberID), Age: age,
			Problem: fmt.Sprintf("has waited %s on %s; an answer usually takes %s (median of %d earlier waits)", teamhealth.Age(age), on, teamhealth.Age(usual), len(prior)),
			Suggest: "ask who it waits on, or check on it"})
	}
	m.clearGoneDeviations(ctx, project, live)
	m.mu.Lock()
	if m.devPending == nil {
		m.devPending = map[string][]deviationSaid{}
	}
	m.devPending[project] = pending
	m.mu.Unlock()
	return items
}

// taskByID2 gives resolveWait the tasks by number.
func taskByID2(byID map[string]board.Task) map[int64]board.Task {
	out := map[int64]board.Task{}
	for _, t := range byID {
		out[t.ID] = t
	}
	return out
}

// clearGoneDeviations clears the counters of findings whose task or wait is gone, so the same one later is new again.
func (m *BoardHealthMonitor) clearGoneDeviations(ctx context.Context, project string, live map[string]bool) {
	esc, err := m.store.HealthEscalations(ctx, project)
	if err != nil {
		return
	}
	for _, e := range esc {
		if strings.HasPrefix(e.Rule, deviationRulePrefix) && !live[e.Subject] {
			_ = m.store.ResetHealthCounter(ctx, project, e.Rule, e.Target, e.Subject)
		}
	}
}

// markDeviationsShown records as said the findings that went out in text (the check composed last for the board and delivered).
func (m *BoardHealthMonitor) markDeviationsShown(ctx context.Context, project, text string, now time.Time) {
	m.mu.Lock()
	composed := m.devPending[project]
	delete(m.devPending, project)
	m.mu.Unlock()
	for _, d := range composed {
		if strings.Contains(text, d.needle) {
			_ = m.store.MarkHealthEscalated(ctx, project, d.rule, d.target, d.subject, now)
		}
	}
}
