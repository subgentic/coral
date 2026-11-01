package routes

// An answer where the person asked (#11722, the Operator's request): a comment relayed to an agent carries the exact reply command, yet an agent answered on the board only. The ask is the tracking: it is open until
// the agent replies in the thread (replies > 0 closes the waiting). Coral reminds the agent ONCE with the reply command when ten minutes passed with no reply in the thread, or sooner when the agent has posted
// on the board about the file (its last post names the artifact) without replying in the thread; the owner's thread says "seen by <agent>" once the agent read the threads or replied, and "reminded" once it was nudged.

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

const (
	replyNudgeAfter = 10 * time.Minute // no reply in the thread this long after the comment was relayed: remind the agent
	replyNudgeEvery = 30 * time.Second // how often the monitor looks
	replyNudgeBatch = 200              // asks looked at in one pass
)

// typedReplyNudge is what is typed into an agent that has not answered in the thread: fixed words, the artifact's id and the comment's number, and the reply command (the census, goal #7).
func typedReplyNudge(artifactID string, commentID int64) string {
	return fmt.Sprintf("You have a comment from the Operator on an artifact that is not answered in its thread: an answer on the board does not reach them there. Answer in the thread with: %s", sendReplyCommand(artifactID, commentID))
}

// RunCommentReplyNudges looks for unanswered relayed comments until ctx ends.
func (h *SessionsHandler) RunCommentReplyNudges(ctx context.Context) {
	t := time.NewTicker(replyNudgeEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			h.nudgeUnansweredComments(ctx, now)
		}
	}
}

// nudgeUnansweredComments is one pass: each ask still waiting for a reply in its thread that is due (ten minutes, or the agent posted about the file on the board) gets the reply command typed into it, once.
func (h *SessionsHandler) nudgeUnansweredComments(ctx context.Context, now time.Time) {
	if h.ss == nil || h.bs == nil || (h.replyNudgeSend == nil && h.boardHandler == nil) {
		return
	}
	asks, err := h.ss.AwaitingAsks(ctx, now, replyNudgeBatch)
	if err != nil {
		return
	}
	for _, a := range asks {
		created, perr := time.Parse(store.ISOFormat, a.CreatedAt)
		if perr != nil {
			continue
		}
		ls, lerr := h.ss.GetLiveSession(ctx, a.AgentSession)
		if lerr != nil || ls == nil || ls.IsArchived == 1 || ls.IsSleeping == 1 || ls.AgentType == "terminal" {
			continue // an agent that is gone or asleep finds the message when it wakes; it is looked at again later
		}
		sessionName := naming.SessionName(ls.AgentType, ls.SessionID)
		due := now.Sub(created) >= replyNudgeAfter
		if !due {
			due = h.postedAboutArtifact(ctx, a, sessionName, created)
		}
		if !due || (h.boardHandler != nil && h.boardHandler.IsPaused(a.Board)) {
			continue
		}
		// Marked BEFORE it is typed, so a failure to record cannot make the pass type it again every 30 seconds; a send that fails takes the mark back and is tried on a later pass.
		marked, merr := h.ss.MarkAskNudged(ctx, a.ID, now)
		if merr != nil || !marked {
			continue
		}
		if err := h.typeReplyNudge(ctx, a.Board, sessionName, typedReplyNudge(a.ArtifactID, a.CommentID)); err != nil {
			slog.Warn("[artifact comments] a reminder to answer in the thread was not typed", "artifact", a.ArtifactID, "comment", a.CommentID, "error", err)
			if cerr := h.ss.ClearAskNudged(ctx, a.ID); cerr != nil {
				slog.Warn("[artifact comments] a reminder's mark was not taken back", "error", cerr)
			}
		}
	}
}

// postedAboutArtifact says the agent's newest post on the board, made after the comment was relayed, names the artifact (its id or its first 12 characters): it answered where it was not asked.
func (h *SessionsHandler) postedAboutArtifact(ctx context.Context, a store.ArtifactAsk, sessionName string, since time.Time) bool {
	sub, err := h.bs.GetSubscriptionBySessionName(ctx, sessionName)
	if err != nil || sub == nil {
		return false
	}
	content, at, err := h.bs.LastPostBy(ctx, a.Board, sub.SubscriberID)
	if err != nil || content == "" || at.Before(since.Truncate(time.Second)) { // LastPostBy has the time to the second
		return false
	}
	low := strings.ToLower(content)
	return strings.Contains(low, a.ArtifactID) || strings.Contains(low, a.ArtifactID[:12])
}

// typeReplyNudge types the reminder into the agent (a test's recorder when one is set). The text is always typedReplyNudge's (the census, goal #7).
func (h *SessionsHandler) typeReplyNudge(ctx context.Context, project, sessionName, text string) error {
	if h.replyNudgeSend != nil {
		return h.replyNudgeSend(ctx, project, sessionName, text)
	}
	return h.boardHandler.sendAutomated(ctx, project, sessionName, text)
}
