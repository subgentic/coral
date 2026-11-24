package background

import (
	"context"
	"fmt"
	"strings"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/jsonl"
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
	if m.limit == nil && m.claudeLimit == nil {
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
			resets, blocked = m.limitOf(ctx, a, tick)
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
	if m.defuse == nil || m.postNotice == nil {
		m.logger.Warn("limit notice not posted: no notice path set", "project", project, "agent", agent)
		return
	}
	work := "no open task"
	for _, t := range tasks {
		if t.AssignedTo != nil && board.SameIdentity(*t.AssignedTo, agent) && t.Status == "in_progress" {
			work = fmt.Sprintf("open task #%d %s", t.ID, m.defuse(ctx, project, teamhealth.ShownText(t.Title, nil))) // the title is stored text: defused as every notice that quotes one is
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
	msg, err := m.postNotice(ctx, project, limitNoticeSender, text)
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

// limitOf says whether a is stopped by a usage limit for the notice, and when it resets (0 when not shown). A Claude agent's limit is its transcript's own
// record (the one the live list's "blocked" and the resumer read, #20691, #20692); the other CLIs' limits are the screens the health check reads.
func (m *BoardHealthMonitor) limitOf(ctx context.Context, a AgentInfo, now time.Time) (time.Duration, bool) {
	if (a.AgentType == at.Claude || a.AgentType == "") && m.claudeLimit != nil {
		if resets, blocked := m.claudeLimit(ctx, a, now); blocked {
			return resets, true
		}
	}
	return m.blockedByLimit(ctx, a)
}

// claudeTranscriptLimit reads a Claude agent's limit off the latest record of its transcript: a usage-limit error whose reset (when it names one) has not come.
func claudeTranscriptLimit(reader *jsonl.SessionReader) func(context.Context, AgentInfo, time.Time) (time.Duration, bool) {
	return func(_ context.Context, a AgentInfo, now time.Time) (time.Duration, bool) {
		e, ok := reader.ReadClaudeAPIError(a.SessionID, a.WorkingDirectory)
		if !ok || !e.UsageLimit() {
			return 0, false
		}
		resetAt, _ := e.ResetsAt()
		if resetAt.IsZero() {
			return 0, true
		}
		if !resetAt.After(now) {
			return 0, false // the reset has come: the agent may work again
		}
		return resetAt.Sub(now), true
	}
}
