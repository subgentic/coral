package background

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// ruleReviewNudge is the health rule for a review task waiting in a reviewer's queue (#19910).
const ruleReviewNudge = "review-nudge"

// reviewNudgeAfter is how long a review task (new, or reopened for the next round) waits before its idle reviewer is told: minutes, not the claim nudge's idle period. A reviewer sat 80 minutes
// on two resubmissions because the claim nudge looked at an agent parked in `coral-board wait` and stood down ("it is waiting"), though what it waited for was older than the review.
const reviewNudgeAfter = 2 * time.Minute

// reviewWait is an agent's active wait: when it began, and whether it is a question to the Operator.
type reviewWait struct {
	at       time.Time
	operator bool
}

func isReviewTask(t board.Task) bool { return strings.HasPrefix(t.Title, "Review #") }

// withoutReviews is the pending tasks the claim nudge looks at: a review task has its own rule (reviewNudge), which would otherwise say the same thing a second time.
func withoutReviews(pending []board.Task) []board.Task {
	var out []board.Task
	for _, t := range pending {
		if !isReviewTask(t) {
			out = append(out, t)
		}
	}
	return out
}

func parseTaskTime(s string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z", "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// reviewNudge: a review task in an agent's queue (a new one, or one reopened for the next round: its time is the reopening) with nothing in progress gets one nudge once it has waited
// reviewNudgeAfter, and an escalation to the orchestrator when the agent has not claimed it ClaimNudge.AfterMin (10 minutes) after that nudge. The counter's subject carries the task's own time, so a
// round that reopens the task is counted afresh instead of inheriting the last round's nudges or escalation.
//
// An agent parked in `coral-board wait` is idle, however its last hook event reads: a wait that began before the review was reopened cannot be waiting for it. That wait is ended, so the
// tool call returns and the nudge is read; a wait that began after the review was there is left to run (the agent knows of it, and it ends on what the agent chose to wait for).
func (r *healthRun) reviewNudge(ctx context.Context, sub board.Subscriber, a AgentInfo, mine, pending []board.Task, sig agentSignal, known bool, wait *reviewWait) {
	h, project := r.h, r.project
	if len(mine) > 0 || !r.hs.ClaimNudge.On {
		h.store.ResetHealthCounters(ctx, project, ruleReviewNudge, sub.SubscriberID)
		return
	}
	var t *board.Task
	for i := range pending {
		if isReviewTask(pending[i]) {
			t = &pending[i]
			break
		}
	}
	if t == nil || (wait != nil && wait.operator) {
		h.store.ResetHealthCounters(ctx, project, ruleReviewNudge, sub.SubscriberID)
		return
	}
	since := parseTaskTime(t.UpdatedAt)
	if since.IsZero() {
		since = parseTaskTime(t.CreatedAt)
	}
	if since.IsZero() || r.now.Sub(since) < reviewNudgeAfter {
		return
	}
	subject := fmt.Sprintf("%d@%s", t.ID, t.UpdatedAt)
	c, err := h.store.GetHealthCounter(ctx, project, ruleReviewNudge, sub.SubscriberID, subject)
	if err != nil || c.Escalated {
		return
	}
	escalateAfter := healthMinutes(r.hs.ClaimNudge.AfterMin)
	if c.Count >= 1 {
		if last := parseTaskTime(c.LastAt); !last.IsZero() && r.now.Sub(last) >= escalateAfter {
			if h.store.MarkHealthEscalated(ctx, project, ruleReviewNudge, sub.SubscriberID, subject, r.now) == nil {
				r.escalated = append(r.escalated, fmt.Sprintf("%s has not claimed review #%d, %d minutes after Coral's nudge", teamhealth.Name(sub.SubscriberID), t.ID, int(escalateAfter/time.Minute)))
			}
		}
		return
	}
	parked := wait != nil && wait.at.Before(since)
	if !parked && (wait != nil || !known || sig.InTurn || sig.NeedsInput || sig.Since.IsZero() || r.now.Sub(sig.Since) < reviewNudgeAfter) {
		return
	}
	if !r.take(ctx, ruleReviewNudge, sub.SubscriberID, time.Minute) {
		return
	}
	if parked {
		h.store.CancelActiveWait(ctx, project, sub.SubscriberID)
	}
	if sendUnlessBlocked(ctx, h.limit, h.deliver, a, "health-review:"+project, claimNudgeText(t.ID)) == nil {
		h.store.BumpHealthCounter(ctx, project, ruleReviewNudge, sub.SubscriberID, subject, r.now)
		r.claimed = append(r.claimed, fmt.Sprintf("%s (#%d)", teamhealth.Name(sub.SubscriberID), t.ID))
	}
}
