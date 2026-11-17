package routes

// Comments wait for a busy agent (#14860, the Operator's request): "Agents that have current tasks are getting messages through artifacts and it is disrupting work." A comment relayed to an agent is a board
// message that tags it, which is typed into the agent at once, even mid-turn. A comment is held while the agent is in a turn (not for its open task: an idle agent waiting for the Operator's review has one, #19093) and
// posted when the turn ends; several held for one agent arrive as one message, in order. The ask row holds the message (it survives a restart). A comment is never typed mid-turn.

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

const (
	commentHoldEvery = 5 * time.Second // how often the held comments are looked at
	commentHoldBatch = 200
)

// commentHeld says whether a comment for this agent waits: only while it is in a turn (#14860, #19093). An agent that has a task open but is idle (it waits for the Operator's review, the usual case) is not disturbed by a
// comment, and holding for the task would hold it for ever: anything that should be delivered is. A check that fails does not hold (today's behaviour).
func (h *SessionsHandler) commentHeld(ctx context.Context, ls *store.LiveSession, project string, sub *board.Subscriber) bool {
	if h.waitingOnBoard(ctx, project, sub) {
		return false // a turn parked in coral-board wait has nothing to disturb: a comment is what it may be waiting for (#19085)
	}
	st := h.deriveSingleSessionState(ctx, ls.SessionID, 0)
	return st.InTurn || st.Working
}

// waitingOnBoard says whether the agent has an active coral-board wait (for a reply, a task, a commit or the Operator): its turn and its task are both open, but it is idle until something wakes it.
func (h *SessionsHandler) waitingOnBoard(ctx context.Context, project string, sub *board.Subscriber) bool {
	if h.bs == nil || project == "" || sub == nil {
		return false
	}
	w, err := h.bs.GetActiveWait(ctx, project, sub.SubscriberID)
	return err == nil && w != nil && w.SessionName == sub.SessionName // the row of a session the agent has since left (a restart) is not this one's wait
}

// holdOrPost delivers the comment message to the agent now when it is free, or keeps it on the ask when it is busy (held true). posted is the board message when it went out.
func (h *SessionsHandler) holdOrPost(ctx context.Context, ls *store.LiveSession, sub *board.Subscriber, project string, commentID int64, msg string, system bool) (posted *board.Message, held bool, err error) {
	if sub != nil && h.commentHeld(ctx, ls, project, sub) {
		if ok, herr := h.ss.HoldAskMessage(ctx, commentID, ls.SessionID, msg, system, time.Now()); herr == nil && ok {
			return nil, true, nil
		} else if herr != nil {
			slog.Warn("[artifact comments] a comment could not be held; it goes now", "error", herr)
		}
	}
	posted, err = h.postHeldMessage(ctx, project, msg, system)
	return posted, false, err
}

// postHeldMessage posts a comment's board message as the Operator (Send to agent) or as Coral's own notice (the delivery on writing).
func (h *SessionsHandler) postHeldMessage(ctx context.Context, project, msg string, system bool) (*board.Message, error) {
	if system {
		return h.postCommentMessage(ctx, project, msg)
	}
	return h.bs.PostDefusedMessage(ctx, project, board.OperatorName, msg)
}

// RunCommentHolds posts the held comments of agents that became free, until ctx ends.
func (h *SessionsHandler) RunCommentHolds(ctx context.Context) {
	t := time.NewTicker(commentHoldEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.flushHeldComments(ctx, time.Now())
		}
	}
}

// flushHeldComments is one pass: for each agent holding comments that is free for them, one board message (the held ones joined in the order they were held) is posted and the holds end.
func (h *SessionsHandler) flushHeldComments(ctx context.Context, now time.Time) {
	if h.ss == nil || h.bs == nil || h.ts == nil {
		return
	}
	asks, err := h.ss.HeldAsks(ctx, commentHoldBatch)
	if err != nil || len(asks) == 0 {
		return
	}
	type group struct {
		asks []store.ArtifactAsk
	}
	var order []string
	groups := map[string]*group{}
	for _, a := range asks {
		k := a.Board + "\x00" + a.AgentSession
		g := groups[k]
		if g == nil {
			g = &group{}
			groups[k] = g
			order = append(order, k)
		}
		g.asks = append(g.asks, a)
	}
	notify := map[string]bool{}
	for _, k := range order {
		g := groups[k]
		first := g.asks[0]
		ls, err := h.ss.GetLiveSession(ctx, first.AgentSession)
		if err != nil || ls == nil || ls.IsArchived == 1 || ls.IsSleeping == 1 || ls.AgentType == "terminal" {
			continue
		}
		if h.boardHandler != nil && h.boardHandler.IsPaused(first.Board) {
			continue
		}
		sub, err := h.bs.GetSubscriptionBySessionName(ctx, naming.SessionName(ls.AgentType, ls.SessionID))
		if err != nil || sub == nil {
			continue
		}
		if h.commentHeld(ctx, ls, first.Board, sub) {
			continue
		}
		var parts []string
		ids := make([]int64, 0, len(g.asks))
		for _, a := range g.asks {
			parts = append(parts, a.QueuedMsg)
			ids = append(ids, a.ID)
		}
		msg := strings.Join(parts, "\n\n")
		system := first.QueuedSystem != 0
		posted, err := h.postHeldMessage(ctx, first.Board, msg, system)
		if err != nil {
			slog.Warn("[artifact comments] a held comment was not posted; it stays held", "board", first.Board, "error", err)
			continue
		}
		for _, a := range g.asks {
			h.linkCommentMessage(ctx, first.Board, posted, a.CommentID, a.AgentSession)
		}
		h.operatorPostedTo(first.Board, msg, sub.SubscriberID) // a delivery ends the waits it matches, an automatic one too: what is delivered overrides the wait (#19085)
		if _, err := h.ss.ReleaseHeldAsks(ctx, ids, now); err != nil {
			slog.Warn("[artifact comments] a held comment's hold was not cleared", "error", err)
		}
		notify[first.Board] = true
		slog.Info("[artifact comments] held comments delivered to a free agent", "agent", sub.JobTitle, "board", first.Board, "comments", len(ids))
	}
	if h.boardHandler != nil && h.boardHandler.notifyFn != nil {
		for b := range notify {
			h.boardHandler.notifyFn(b)
		}
	}
}
