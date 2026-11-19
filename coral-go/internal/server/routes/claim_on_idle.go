package routes

import (
	"context"
	"fmt"
	"sync"
)

// An agent whose turn ends with a task assigned to it and still unclaimed is told again at once, in its Stop hook's feedback (#19802, the Operator: an agent that read "[Task #N available] ... when your current task is done" finished its
// work, went idle and sat on a critical task for 14 minutes: the first notice was read, and the periodic claim nudge was not yet due). Its turn ending is Coral's idle state (the "stop" event); nothing else is
// looked at. One re-notice per task: the agent that ends its next turn still without claiming it is left to the periodic nudges, so this never becomes a loop.
type claimReNotices struct {
	mu   sync.Mutex
	sent map[string]int64 // the session name -> the task it was last re-told about
}

func (c *claimReNotices) already(session string, task int64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sent[session] == task
}

func (c *claimReNotices) mark(session string, task int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sent == nil {
		c.sent = map[string]int64{}
	}
	c.sent[session] = task
}

func (c *claimReNotices) forget(session string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.sent, session)
}

// claimWaitingText is the notice: the periodic claim nudge's words (internal/background), so an agent reads one sentence whichever sends it.
func claimWaitingText(id int64) string {
	return fmt.Sprintf("[Coral] #%d is assigned to you and waiting. Run 'coral-board task claim %d' to start it.", id, id)
}

// claimNoticeAtIdle is what the Stop hook of the agent of sessionName carries when its turn ends with nothing unread to hand over: the claim notice for its highest-priority pending task that is assigned to it, when it
// has nothing in progress and the task has not been re-announced already. "" when there is nothing to say.
func (h *SessionsHandler) claimNoticeAtIdle(ctx context.Context, sessionName string) string {
	if h.bs == nil || sessionName == "" {
		return ""
	}
	sub, err := h.bs.GetSubscriptionBySessionName(ctx, sessionName)
	if err != nil || sub == nil {
		return ""
	}
	if busy, err := h.bs.HasActiveTaskForAssignee(ctx, sub.Project, sub.SubscriberID, 0); err != nil || busy {
		h.claimReNotices.forget(sessionName) // it took work: a later idle with another task is told again
		return ""
	}
	next := h.bs.NextPendingTaskForSubscriber(ctx, sub.Project, sub.SubscriberID)
	if !taskAssignedToSubscriber(next, sub.SubscriberID) {
		h.claimReNotices.forget(sessionName)
		return ""
	}
	if h.claimReNotices.already(sessionName, next.ID) {
		return ""
	}
	h.claimReNotices.mark(sessionName, next.ID)
	return claimWaitingText(next.ID)
}
