package routes

// Comments wait for a busy agent (#14860, the Operator's request): "Agents that have current tasks are getting messages through artifacts and it is disrupting work." A comment relayed to an agent is a board
// message that tags it, which is typed into the agent at once, even mid-turn. Like a board task notification (deferred while the agent has an active task), a comment is now held while the agent is busy and
// posted when it is free; several held for one agent arrive as one message, in order. The ask row holds the message (it survives a restart). The Operator can mark a comment "now": it then waits only for the end
// of the agent's turn, not for its task, and is never typed mid-turn.

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

// commentHeld says whether a comment for this agent waits: it is mid-turn (always), or it has an active task and the comment is not marked "now". A check that fails does not hold (today's behaviour).
func (h *SessionsHandler) commentHeld(ctx context.Context, ls *store.LiveSession, project string, sub *board.Subscriber, now bool) bool {
	if st := h.deriveSingleSessionState(ctx, ls.SessionID, 0); st.InTurn || st.Working {
		return true
	}
	if now || h.bs == nil || project == "" || sub == nil {
		return false
	}
	for _, who := range []string{sub.JobTitle, sub.SubscriberID} { // tasks are assigned by the role the board knows the member by
		if active, err := h.bs.HasActiveTaskForAssignee(ctx, project, who, 0); err == nil && active {
			return true
		}
	}
	return false
}

// holdOrPost delivers the comment message to the agent now when it is free, or keeps it on the ask when it is busy (held true). posted is the board message when it went out.
func (h *SessionsHandler) holdOrPost(ctx context.Context, ls *store.LiveSession, sub *board.Subscriber, project string, commentID int64, msg string, now, system bool) (posted *board.Message, held bool, err error) {
	if sub != nil && h.commentHeld(ctx, ls, project, sub, now) {
		if ok, herr := h.ss.HoldAskMessage(ctx, commentID, ls.SessionID, msg, now, system, time.Now()); herr == nil && ok {
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
		now  bool
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
		g.now = g.now || a.QueuedNow != 0
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
		if h.commentHeld(ctx, ls, first.Board, sub, g.now) {
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
		if !system {
			h.operatorPosted(first.Board, msg)
		}
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
