package routes

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The Operator's comment on an artifact that waits for their review reaches the agent that uploaded it (#11420): "I should be able to interact strictly through the inbox". One board message from the
// Operator on the same path Send to agent uses (sendMessage: the comment as quoted, untrusted data between markers, redacted, cleaned and capped, with the exact reply command), and the ask that lets the
// agent answer in that thread. Only the person at this computer, only on an artifact tagged "for review" on the comment's board, only to the agent that uploaded it and is still on that board, never through
// Coral Hub, and not when the request says notify_agent false. A comment on any other artifact, or by anyone else, sends nothing.

// forReviewTag is the tag a team puts on an artifact a person must look at (board.StarterArtifactTags).
const forReviewTag = "for review"

// autoDelivery is what became of the delivery of one comment: who it went to, or why it did not (never shown to the agent).
type autoDelivery struct {
	To     string // the agent's title, "" when nothing was sent
	Reason string // not_owner, not_for_review, no_uploader, asleep_or_gone, board_paused, rate_limited, redaction_unavailable, failed
}

// deliverOperatorComment sends the Operator's new comment c (on artifact id, board b) to the uploading agent when the rules above hold. Best effort: the comment is already kept, so a failure is logged
// and the comment stands.
func (h *SessionsHandler) deliverOperatorComment(r *http.Request, caller commentCaller, c store.ArtifactComment, id, b string) autoDelivery {
	if caller.Kind != commentCallerOwner || caller.ViaHub || !humanInputCaller(r) || cloud.Tunneled(r) || r.Header.Get(tunnel.ViaHeader) != "" {
		return autoDelivery{Reason: "not_owner"}
	}
	if b == "" || h.bs == nil || h.ss == nil {
		return autoDelivery{Reason: "not_for_review"}
	}
	ctx := r.Context()
	tags, err := h.bs.ArtifactTags(ctx, b)
	if err != nil || !hasTag(tags[id], forReviewTag) {
		return autoDelivery{Reason: "not_for_review"}
	}
	subs, err := h.bs.ListSubscribers(ctx, b)
	if err != nil {
		return autoDelivery{Reason: "failed"}
	}
	// The uploader is the agent of this board that has an upload record for exactly this object: a direct look at each member's own record, never a walk of every record.
	var up *board.Subscriber
	sessionID := ""
	for i := range subs {
		sid := naming.SessionIDFromName(subs[i].SessionName)
		if sid == "" {
			continue
		}
		if rec, ok := readUploadRecord(h.cfg.CoralDir(), sid, id); ok && (rec.Board == "" || rec.Board == b) && rec.UploadedBy == "" {
			up, sessionID = &subs[i], sid
			break
		}
	}
	if up == nil {
		return autoDelivery{Reason: "no_uploader"}
	}
	ls, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || ls == nil || ls.IsArchived == 1 || ls.AgentType == "terminal" {
		return autoDelivery{Reason: "asleep_or_gone"} // an agent that is gone has no one to tell; one that sleeps finds the message unread when it wakes (below)
	}
	if h.boardHandler != nil && h.boardHandler.IsPaused(b) {
		return autoDelivery{Reason: "board_paused"}
	}
	key := caller.Issuer + "|" + caller.Subject
	if !h.sendLimit.allow(key, time.Now()) {
		return autoDelivery{Reason: "rate_limited"}
	}
	title := cleanAgentName(up.JobTitle)
	if title == "" {
		return autoDelivery{Reason: "no_uploader"}
	}
	rootID := c.ID
	root := c
	if c.ParentID != nil {
		rootID = *c.ParentID
		if t, found, err := h.ss.GetArtifactComment(ctx, id, rootID); err == nil && found {
			root = t
		}
	}
	text, ok1 := sendQuote(c.Body, 2*sendCommentCap)
	snippet, ok2 := "", true
	if a := anchorOfComment(root); a != nil && !a.Whole {
		snippet, ok2 = sendQuote(strings.TrimSpace(a.Prefix+" ["+a.Quote+"] "+a.Suffix), sendSnippetCap)
	}
	if !ok1 || !ok2 {
		return autoDelivery{Reason: "redaction_unavailable"}
	}
	var names []string
	for _, s := range subs {
		names = append(names, s.SubscriberID)
		if tt := strings.TrimSpace(s.JobTitle); tt != "" {
			names = append(names, tt)
		}
	}
	// The ask lets the agent answer in this thread (replying is gated on it); an open one is kept as it is, so a second comment in the thread is one more message and no second ask.
	if _, _, err := h.ss.CreateArtifactAsk(ctx, rootID, id, b, sessionID, title, time.Now()); err != nil {
		slog.Warn("[artifact comments] ask not recorded", "error", err)
		return autoDelivery{Reason: "failed"}
	}
	msg := sendMessage(title, "the owner", h.sendVersionLine(id), sendReplyCommand(id, rootID), text, snippet, names)
	if _, err := h.bs.PostDefusedMessage(ctx, b, board.OperatorName, msg); err != nil {
		slog.Warn("[artifact comments] message not posted", "board", b, "error", err)
		return autoDelivery{Reason: "failed"}
	}
	if h.boardHandler != nil && h.boardHandler.notifyFn != nil {
		h.boardHandler.notifyFn(b)
	}
	slog.Info("[artifact comments] the Operator's comment sent to the uploading agent", "artifact", id, "comment", c.ID, "agent", title, "board", b)
	return autoDelivery{To: title}
}
