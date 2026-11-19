package background

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// idleReviewAfter is how long a review task may wait with its reviewer idle before it is an item for the team's orchestrator (#19910).
const idleReviewAfter = 20 * time.Minute

// idleReviewItems: a review task pending or in progress for idleReviewAfter whose reviewer is idle (the same idle signal as the "idle" item: no turn, no dialog, a hook event that old) is the
// orchestrator's to chase: it can peek the reviewer and post to it. Every team gets it, not only the one that found it: two resubmissions sat 80 minutes with QA Reviewer 2 and an hour with
// Security Reviewer, both at the prompt. One item per reviewer (the longest waiting review is the one named); its state lists the reviews and rounds, so a new review or a new round is news again.
//
// A reviewer parked in `coral-board wait` reads as in a turn for ever (its tool call has no end): a wait that began before the review was last touched is idle for this item, as the review cannot be
// what it waits for. The orchestrator itself is never named.
func (m *BoardHealthMonitor) idleReviewItems(ctx context.Context, project, orch string, subs []board.Subscriber, bySession map[string]AgentInfo, tasks []board.Task, waits []board.RegisteredWait, now time.Time) []teamhealth.Item {
	reviews, err := m.store.OpenReviews(ctx, project)
	if err != nil || len(reviews) == 0 {
		return nil
	}
	isReview := map[int64]bool{}
	for _, ids := range reviews {
		for _, id := range ids {
			isReview[id] = true
		}
	}
	byAgent := map[string][]board.Task{}
	for _, t := range tasks {
		if t.AssignedTo != nil && isReview[t.ID] && (t.Status == "pending" || t.Status == "in_progress") {
			byAgent[*t.AssignedTo] = append(byAgent[*t.AssignedTo], t)
		}
	}
	waitAt := map[string]time.Time{}
	for _, w := range waits {
		if w.WaitType == board.WaitOperator {
			waitAt[w.SubscriberID] = now.Add(time.Hour) // a question to the Operator: not idle, after any review
			continue
		}
		waitAt[w.SubscriberID] = parseTaskTime(w.CreatedAt)
	}
	var items []teamhealth.Item
	for _, sub := range subs {
		a, live := bySession[sub.SessionName]
		mine := byAgent[sub.SubscriberID]
		if !live || len(mine) == 0 || board.SameIdentity(sub.SubscriberID, orch) {
			continue
		}
		sig, known := m.signal(ctx, a.SessionID)
		if !known || sig.NeedsInput || sig.Since.IsZero() {
			continue
		}
		if _, blocked := m.blockedByLimit(ctx, a); blocked {
			continue
		}
		type late struct {
			t     board.Task
			since time.Time
		}
		var lates []late
		for _, t := range mine {
			since := parseTaskTime(t.UpdatedAt)
			if since.IsZero() || now.Sub(since) < idleReviewAfter {
				continue
			}
			wAt, hasWait := waitAt[sub.SubscriberID]
			idle := !sig.InTurn || (hasWait && wAt.Before(since))
			if !idle {
				continue
			}
			lates = append(lates, late{t, since})
		}
		if len(lates) == 0 {
			continue
		}
		sort.Slice(lates, func(i, j int) bool { return lates[i].since.Before(lates[j].since) })
		var state []string
		var named string
		for i, l := range lates {
			desc := reviewLabel(ctx, m.store, project, l.t)
			state = append(state, fmt.Sprintf("%d:%s", l.t.ID, desc))
			if i == 0 {
				named = fmt.Sprintf("#%d (%s) waiting %s", l.t.ID, desc, teamhealth.Age(now.Sub(l.since)))
			}
		}
		items = append(items, teamhealth.Item{Rank: 2, Age: now.Sub(lates[0].since), Agent: teamhealth.Name(sub.SubscriberID),
			Problem: named + ", reviewer idle",
			Suggest: "peek it and post to it directly", Key: "review-idle|" + sub.SubscriberID, State: strings.Join(state, ",")})
	}
	return items
}

// reviewLabel is "review of #M, round K" for a review task (numbers only: no title is typed or posted, rule 1).
func reviewLabel(ctx context.Context, s *board.Store, project string, t board.Task) string {
	full, err := s.GetTask(ctx, project, t.ID)
	if err != nil || full == nil || full.Workflow.ReviewOf == 0 {
		return "review"
	}
	return fmt.Sprintf("review of #%d, round %d", full.Workflow.ReviewOf, full.Workflow.ReviewRound)
}
