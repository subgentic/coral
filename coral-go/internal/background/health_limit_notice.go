package background

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// limitHitClearAfter is how long an agent must be seen unblocked before a new limit is a new hit: a screen that scrolls the notice away for a scan, or a
// retry that is cut short again at once, is the same hit.
const limitHitClearAfter = 30 * time.Minute

// limitNoticeSender is the sender of a limit notice (the health monitor's own name, as the wait escalation uses).
const limitNoticeSender = "Coral Health Monitor"

// noticeLimitHits posts one line to the team's Orchestrator for each agent that has just hit a usage limit (brief task 1, #21018): who, its open task, the
// vendor and when it resets. A limit the agent stays blocked by is the same hit however many scans, retries and nudges see it, so there is one post per hit;
// the next hit, after the agent was seen unblocked for limitHitClearAfter, is a new one. A team with no Orchestrator (or an Orchestrator that is itself
// blocked) gets it as a question to the Operator, so it reaches Needs you.
func (m *BoardHealthMonitor) noticeLimitHits(ctx context.Context, project string, bySession map[string]AgentInfo, tick time.Time) {
	if m.limit == nil {
		return
	}
	subs, err := m.store.ListSubscribers(ctx, project)
	if err != nil {
		return
	}
	orch, _ := m.store.TeamOrchestrator(ctx, project)
	var tasks []board.Task
	loaded := false
	for _, sub := range subs {
		key := project + "|" + sub.SessionName
		a, live := bySession[sub.SessionName]
		resets, blocked := time.Duration(0), false
		if live {
			resets, blocked = m.blockedByLimit(ctx, a)
		}
		m.mu.Lock()
		if m.limitHits == nil {
			m.limitHits = map[string]time.Time{}
		}
		last, hit := m.limitHits[key]
		switch {
		case blocked:
			m.limitHits[key] = tick
		case hit && tick.Sub(last) >= limitHitClearAfter:
			delete(m.limitHits, key)
		}
		m.mu.Unlock()
		if !blocked || hit {
			continue
		}
		if !loaded {
			tasks, _ = m.store.ListOpenTaskStates(ctx, project)
			loaded = true
		}
		m.postLimitHit(ctx, project, sub.SubscriberID, a, resets, tasks, orch)
	}
}

func (m *BoardHealthMonitor) postLimitHit(ctx context.Context, project, agent string, a AgentInfo, resets time.Duration, tasks []board.Task, orch string) {
	work := "no open task"
	for _, t := range tasks {
		if t.AssignedTo != nil && board.SameIdentity(*t.AssignedTo, agent) && t.Status == "in_progress" {
			work = fmt.Sprintf("open task #%d %s", t.ID, teamhealth.ShownText(t.Title, nil))
			break
		}
	}
	when := "reset time not shown"
	if resets > 0 {
		when = "resets in " + teamhealth.Age(resets)
	}
	vendor := strings.TrimSpace(a.AgentType)
	if vendor == "" {
		vendor = "its CLI's"
	}
	toOperator := orch == "" || board.SameIdentity(orch, agent)
	to := "Operator"
	if !toOperator {
		to = teamhealth.Name(orch)
	}
	text := fmt.Sprintf("@%s %s hit its %s usage limit (%s; %s). It cannot work until the limit resets or its plan changes; Coral types nothing to it meanwhile.",
		to, teamhealth.Name(agent), vendor, work, when)
	msg, err := m.store.PostSystemMessage(ctx, project, limitNoticeSender, text, nil)
	if err != nil {
		m.logger.Warn("limit notice could not be posted", "project", project, "agent", agent, "error", err)
		return
	}
	if toOperator {
		if err := m.store.RecordAsk(ctx, project, msg, []string{"Operator"}); err != nil {
			m.logger.Warn("limit notice could not be asked", "project", project, "error", err)
		}
	}
}
