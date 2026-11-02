package routes

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// Comments on a goal (#11955, the Operator's request: "reuse the same machinery"). They are the document comments pointed at a goal: the same routes (/api/artifacts/{id}/comments...), the same table, caps,
// threads, Resolve and Reopen, pictures, ask gate and agent reply, with a subject key in the place of an artifact's digest: goal:<team>:<goal id>. A digest is 64 hex characters, so a goal key is never an
// artifact (every artifact route refuses it as an invalid id, and no artifact's list can name it), and Coral Hub's table matches routes on {hex64}, so a goal key is never reached through the Hub.
//
// What is not shared, and why: the existence check (a goal has no file: commentArtifactKind checks the goal on its team instead), the anchor (a goal comment is on the whole goal), and the words of the message
// the owner gets (the goal's title and Done when in place of the quoted text).

// goalSubjectRe is a goal's subject key: goal:<team>:<id>, the team as commentBoardRe has it, the id a positive number with no leading zero.
var goalSubjectRe = regexp.MustCompile(`^goal:([A-Za-z0-9][A-Za-z0-9_.-]{0,63}):([1-9][0-9]{0,9})$`)

// goalSubject is the key of goal id on team.
func goalSubject(team string, id int64) string { return fmt.Sprintf("goal:%s:%d", team, id) }

// parseGoalSubject reads a subject key; ok is false for anything else (an artifact's digest included).
func parseGoalSubject(s string) (team string, id int64, ok bool) {
	m := goalSubjectRe.FindStringSubmatch(s)
	if m == nil {
		return "", 0, false
	}
	n, err := strconv.ParseInt(m[2], 10, 64)
	if err != nil {
		return "", 0, false
	}
	return m[1], n, true
}

// goalCommentSubject is commentArtifactKind for a goal key: a key that parses, the goal on that team, and a caller that is the person at this computer or an agent (a guest, a grantee and a Hub viewer have
// no goal comments). It answers the request itself when not and reports false.
func (h *SessionsHandler) goalCommentSubject(w http.ResponseWriter, r *http.Request, id string) bool {
	team, gid, ok := parseGoalSubject(id)
	if !ok {
		errBadRequest(w, "invalid goal")
		return false
	}
	caller, status, code := h.artifactCommentCaller(r)
	if status != 0 {
		commentRefuse(w, status, code, "not allowed")
		return false
	}
	if caller.Kind != commentCallerOwner && caller.Kind != commentCallerAgent {
		commentRefuse(w, http.StatusForbidden, "owner_only", "goal comments are for the person at this computer and the agents asked into a thread")
		return false
	}
	if h.bs == nil {
		errInternalServer(w, "the message board is not available")
		return false
	}
	if _, err := h.bs.GetGoal(r.Context(), team, gid); err != nil {
		if errors.Is(err, board.ErrGoalNotFound) {
			errNotFound(w, "goal not found")
		} else {
			errInternalServer(w, "could not read the goal")
		}
		return false
	}
	return true
}

// goalLink is the link an agent names a goal's thread by: coral://goals/<team>/<id>.
func goalLink(team string, id int64) string { return fmt.Sprintf("coral://goals/%s/%d", team, id) }

// goalOwner is who a comment on the goal goes to: its Driver when that is a subscriber that is a live session, else the team's Orchestrator. note says why when the Driver was named and is not there.
func (h *SessionsHandler) goalOwner(r *http.Request, team string, g *board.Goal, subs []board.Subscriber) (sub board.Subscriber, sessionID, note string, ok bool) {
	ctx := r.Context()
	usable := func(s board.Subscriber) (string, bool) {
		sid := naming.SessionIDFromName(s.SessionName)
		if sid == "" || s.IsActive == 0 {
			return "", false
		}
		ls, err := h.ss.GetLiveSession(ctx, sid)
		if err != nil || ls == nil || ls.IsArchived == 1 || ls.AgentType == "terminal" {
			return "", false // gone; one that sleeps finds the message unread when it wakes
		}
		return sid, true
	}
	if d := strings.TrimSpace(g.Driver); d != "" {
		for _, s := range subs {
			if s.SubscriberID == d {
				if sid, live := usable(s); live {
					return s, sid, "", true
				}
			}
		}
		note = "The goal's Driver " + cleanAgentName(d) + " is not available, so this came to you."
	}
	orch, err := h.bs.TeamOrchestrator(ctx, team)
	if err != nil {
		return board.Subscriber{}, "", "", false
	}
	for _, s := range subs {
		if s.SubscriberID == orch {
			if sid, live := usable(s); live {
				return s, sid, note, true
			}
		}
	}
	return board.Subscriber{}, "", "", false
}

// deliverGoalComment sends the Operator's comment c on the goal to its owner (goalOwner), as deliverOperatorComment does for an upload: one board message from the Operator on the sendMessage path, and the
// ask that lets the owner answer in this thread. Best effort: the comment is kept either way.
func (h *SessionsHandler) deliverGoalComment(r *http.Request, caller commentCaller, c store.ArtifactComment, id, team string, gid int64) autoDelivery {
	if h.bs == nil || h.ss == nil {
		return autoDelivery{Reason: "failed"}
	}
	ctx := r.Context()
	g, err := h.bs.GetGoal(ctx, team, gid)
	if err != nil {
		return autoDelivery{Reason: "failed"}
	}
	subs, err := h.bs.ListSubscribers(ctx, team)
	if err != nil {
		return autoDelivery{Reason: "failed"}
	}
	owner, sessionID, note, ok := h.goalOwner(r, team, g, subs)
	if !ok {
		return autoDelivery{Reason: "asleep_or_gone"}
	}
	if h.boardHandler != nil && h.boardHandler.IsPaused(team) {
		return autoDelivery{Reason: "board_paused"}
	}
	if !h.sendLimit.allow(caller.Issuer+"|"+caller.Subject, time.Now()) {
		return autoDelivery{Reason: "rate_limited"}
	}
	title := cleanAgentName(owner.JobTitle)
	if title == "" {
		return autoDelivery{Reason: "no_uploader"}
	}
	rootID := c.ID
	if c.ParentID != nil {
		rootID = *c.ParentID
	}
	text, ok1 := sendQuote(c.Body, 2*sendCommentCap)
	about := "#" + strconv.FormatInt(g.ID, 10) + " " + g.Title
	if g.DoneWhen != "" {
		about += " | Done when: " + g.DoneWhen
	}
	snippet, ok2 := sendQuote(about, sendSnippetCap)
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
	if _, _, err := h.ss.CreateArtifactAsk(ctx, rootID, id, team, sessionID, title, time.Now()); err != nil {
		slog.Warn("[goal comments] ask not recorded", "error", err)
		return autoDelivery{Reason: "failed"}
	}
	context := fmt.Sprintf("%s (read all of it with: coral-board goal brief %d)", goalLink(team, gid), gid)
	if note != "" {
		context += ". " + note
	}
	msg := sendMessageOf(sendOnGoal, title, "the owner", context, sendReplyCommand(id, rootID), text, snippet, names, commentPictureLinks(c.ImagesJSON)...)
	if _, err := h.bs.PostDefusedMessage(ctx, team, board.OperatorName, msg); err != nil {
		slog.Warn("[goal comments] message not posted", "board", team, "error", err)
		_ = h.ss.CloseArtifactAsk(ctx, rootID, sessionID, time.Now())
		return autoDelivery{Reason: "failed"}
	}
	if h.boardHandler != nil && h.boardHandler.notifyFn != nil {
		h.boardHandler.notifyFn(team)
	}
	slog.Info("[goal comments] the Operator's comment sent to the goal's owner", "board", team, "goal", gid, "comment", c.ID, "agent", title)
	return autoDelivery{To: title}
}

// goalTeamOf is the team a request's goal key names ("" when it is not one).
func goalTeamOf(r *http.Request) string {
	team, _, _ := parseGoalSubject(chi.URLParam(r, "id"))
	return team
}
