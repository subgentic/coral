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
// agent answer in that thread. The Operator's own comment only (the person at this computer, or the owner through Coral Hub: operatorComment), to the agent that uploaded the file and is still on that board (whatever the file's tag), or, for a reply, to the agents already in its thread (#12203), and not when the request says notify_agent false. A comment on any other artifact, or by anyone else, sends nothing.

// autoDelivery is what became of the delivery of one comment: who it went to, or why it did not (never shown to the agent).
type autoDelivery struct {
	To     string // the agent's title, "" when nothing was sent
	Reason string // not_owner, not_for_review, no_uploader, asleep_or_gone, board_paused, rate_limited, redaction_unavailable, failed
}

// deliverOperatorComment sends the Operator's new comment c (on artifact id, board b) to the uploading agent when the rules above hold. Best effort: the comment is already kept, so a failure is logged
// and the comment stands.
func (h *SessionsHandler) deliverOperatorComment(r *http.Request, caller commentCaller, c store.ArtifactComment, id, b string) autoDelivery {
	if !h.operatorComment(r, caller) {
		return autoDelivery{Reason: "not_owner"}
	}
	if team, gid, ok := parseGoalSubject(id); ok { // a goal's comment goes to the goal's owner (#11955)
		return h.deliverGoalComment(r, caller, c, id, team, gid)
	}
	if b == "" || h.bs == nil || h.ss == nil {
		return autoDelivery{Reason: "no_uploader"}
	}
	ctx := r.Context()
	subs, err := h.bs.ListSubscribers(ctx, b)
	if err != nil {
		return autoDelivery{Reason: "failed"}
	}
	rootID := c.ID
	root := c
	if c.ParentID != nil {
		rootID = *c.ParentID
		if t, found, err := h.ss.GetArtifactComment(ctx, id, rootID); err == nil && found {
			root = t
		}
	}
	targets := h.commentTargets(r, subs, id, b, rootID, c.ParentID != nil)
	if len(targets) == 0 {
		return autoDelivery{Reason: "no_uploader"}
	}
	if h.boardHandler != nil && h.boardHandler.IsPaused(b) {
		return autoDelivery{Reason: "board_paused"}
	}
	key := caller.Issuer + "|" + caller.Subject
	if !h.sendLimit.allow(key, time.Now()) {
		return autoDelivery{Reason: "rate_limited"}
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
	var sent []string
	reason := ""
	for _, t := range targets {
		ls, err := h.ss.GetLiveSession(ctx, t.sessionID)
		if err != nil || ls == nil || ls.IsArchived == 1 || ls.AgentType == "terminal" {
			reason = firstReason(reason, "asleep_or_gone") // an agent that is gone has no one to tell; one that sleeps finds the message unread when it wakes
			continue
		}
		title := cleanAgentName(t.sub.JobTitle)
		if title == "" {
			reason = firstReason(reason, "no_uploader")
			continue
		}
		// The ask lets the agent answer in this thread (replying is gated on it); an open one is kept as it is, so a second comment in the thread is one more message and no second ask.
		if _, _, err := h.ss.CreateArtifactAsk(ctx, rootID, id, b, t.sessionID, title, time.Now()); err != nil {
			slog.Warn("[artifact comments] ask not recorded", "error", err)
			reason = firstReason(reason, "failed")
			continue
		}
		msg := sendMessage(title, "the owner", h.sendVersionLine(id), sendReplyCommand(id, rootID), text, snippet, names, commentPictureLinks(c.ImagesJSON)...)
		if _, err := h.bs.PostDefusedMessage(ctx, b, board.OperatorName, msg); err != nil {
			slog.Warn("[artifact comments] message not posted", "board", b, "error", err)
			reason = firstReason(reason, "failed")
			continue
		}
		sent = append(sent, title)
		slog.Info("[artifact comments] the Operator's comment sent to an agent", "artifact", id, "comment", c.ID, "agent", title, "board", b)
	}
	if len(sent) == 0 {
		return autoDelivery{Reason: reason}
	}
	if h.boardHandler != nil && h.boardHandler.notifyFn != nil {
		h.boardHandler.notifyFn(b)
	}
	return autoDelivery{To: strings.Join(sent, ", ")}
}

func firstReason(have, next string) string {
	if have != "" {
		return have
	}
	return next
}

// commentTarget is an agent of the board a comment is to reach, with its session.
type commentTarget struct {
	sub       board.Subscriber
	sessionID string
}

// commentTargets are the agents the owner's comment goes to (#12203). A reply goes to the agents already in its thread (asked into it by hand or by the comment that began it, open or ended: the owner
// is talking to them again), and a first comment, or a reply in a thread nobody is in, to the agent that uploaded the file. The uploader is the agent of this board with an upload record for exactly this
// object: a direct look at each member's own record, never a walk of every record. The file's tag does not matter: an agent that put a file in front of the Operator is the one to answer about it.
func (h *SessionsHandler) commentTargets(r *http.Request, subs []board.Subscriber, id, b string, rootID int64, reply bool) []commentTarget {
	bySession := map[string]int{}
	for i := range subs {
		if sid := naming.SessionIDFromName(subs[i].SessionName); sid != "" {
			bySession[sid] = i
		}
	}
	var out []commentTarget
	if reply {
		asks, err := h.ss.ListArtifactAsks(r.Context(), id)
		if err == nil {
			seen := map[string]bool{}
			for _, a := range asks {
				if a.CommentID != rootID || a.Board != b || seen[a.AgentSession] {
					continue
				}
				if i, ok := bySession[a.AgentSession]; ok { // an agent that left the board is not told
					seen[a.AgentSession] = true
					out = append(out, commentTarget{subs[i], a.AgentSession})
				}
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	for i := range subs {
		sid := naming.SessionIDFromName(subs[i].SessionName)
		if sid == "" {
			continue
		}
		if rec, ok := readUploadRecord(h.cfg.CoralDir(), sid, id); ok && rec.Board == b && rec.UploadedBy == "" {
			return []commentTarget{{subs[i], sid}}
		}
	}
	return nil
}

// operatorComment says the comment is the Operator's own: the person at this computer's dashboard, or the owner through Coral Hub. Who the owner is comes from ONE place, artifactCommentCaller: it makes the owner
// kind (and ViaHub) only for a request that passed the tunnel's owner check on an owner comment route, so a Coral Hub viewer, a guest, a forged stamp and an agent are never the owner here, whatever else they
// carry; nothing is re-derived from a header in this file. Through the Hub the stamp must also be authentic. A team's machine (#7061), where the owner kind is several people under an organisation's issuer,
// is not delivered to an agent on its own: the message says "the Operator", and a team's members are not one person.
func (h *SessionsHandler) operatorComment(r *http.Request, caller commentCaller) bool {
	if caller.Kind != commentCallerOwner {
		return false
	}
	if r.Header.Get(tunnel.ViaHeader) != "" || cloud.Tunneled(r) {
		return caller.ViaHub && cloud.TunneledAuthentic(r) && !isCommentTeamIssuer(caller.Issuer)
	}
	return !caller.ViaHub && humanInputCaller(r)
}
