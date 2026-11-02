// Waits: registering, polling and resolving them (moved out of board.go, #4998; no behaviour change).

package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// RegisterWait parks an agent by registering an active wait condition.
// POST /api/board/{project}/waits
func (h *BoardHandler) RegisterWait(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	var body struct {
		SubscriberID string `json:"subscriber_id"`
		SessionName  string `json:"session_name,omitempty"`
		WaitType     string `json:"wait_type"`
		TargetID     string `json:"target_id"`
		Reason       string `json:"reason"`
		Timeout      string `json:"timeout,omitempty"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	attrWho, attrOK := attributedTo(w, r, body.SubscriberID)
	if !attrOK {
		return
	}
	body.SubscriberID = attrWho
	if body.SubscriberID == "" {
		errBadRequest(w, "subscriber_id required")
		return
	}
	if refuseTextTooLarge(w, "reason_too_large", "a wait's reason", len(body.Reason), maxWaitReasonBytes) {
		return
	}
	if body.WaitType == board.WaitOperator {
		// A question for the Operator: the reason is the question. It is shown to the
		// orchestrator only through teamhealth.ShownText, and is kept short here.
		body.TargetID = "Operator"
		// Only a current member asks, so a made-up name can't add lines to the check.
		if sub, err := h.bs.GetProjectSubscription(r.Context(), project, body.SubscriberID); err != nil || sub == nil {
			errBadRequest(w, "only a member of this board can ask the Operator")
			return
		}
		body.Reason = strings.TrimSpace(body.Reason)
		if body.Reason == "" {
			errBadRequest(w, "a question for the Operator needs its text")
			return
		}
		if r := []rune(body.Reason); len(r) > 500 {
			body.Reason = string(r[:500])
		}
	}
	if body.SessionName == "" {
		if sub, err := h.bs.GetProjectSubscription(r.Context(), project, body.SubscriberID); err == nil && sub != nil {
			body.SessionName = sub.SessionName
		}
	}
	timeout := board.DefaultWaitTimeout
	if body.Timeout != "" {
		d, err := time.ParseDuration(body.Timeout)
		if err != nil || d <= 0 {
			msg := "timeout must be a duration such as 30m or 2h"
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": msg, "message": msg, "code": "invalid_timeout", "not_saved": true})
			return
		}
		timeout = d
	}
	// An agent waits on one thing per board, so a new wait replaces its old one. A question the Operator has not answered must not go with it (#11919: the second of two questions replaced the first in
	// Needs you): the one being replaced is kept as an ordinary open question from the same agent, below.
	h.keepExpiredOperatorQuestions(r.Context(), project)                          // a wait that ran out and was not noticed yet is cancelled below with the rest: keep its question first (#11919)
	replaced := h.activeOperatorQuestion(r.Context(), project, body.SubscriberID) // whatever the new wait's type: any new wait replaces the old one
	if replaced != nil && body.WaitType == board.WaitOperator && strings.EqualFold(strings.TrimSpace(replaced.Reason), strings.TrimSpace(body.Reason)) {
		replaced = nil // the same question asked again: the new wait is it, not a second one
	}
	wait, err := h.bs.RegisterWait(r.Context(), project, body.SubscriberID, body.SessionName, body.WaitType, body.TargetID, body.Reason, timeout)
	if err == nil && replaced != nil {
		h.keepReplacedOperatorQuestion(r.Context(), project, replaced)
	}
	if errors.Is(err, board.ErrTooManyWaits) {
		msg := err.Error()
		writeJSON(w, http.StatusConflict, map[string]any{"error": msg, "message": msg, "code": "too_many_waits", "max": board.MaxActiveWaitsPerSubscriber, "not_saved": true})
		return
	}
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, wait)
}

// GetActiveWait returns active registered wait(s) for a subscriber or board.
// GET /api/board/{project}/waits
func (h *BoardHandler) GetActiveWait(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	subscriberID := r.URL.Query().Get("subscriber_id")
	if subscriberID != "" {
		attrWho, attrOK := attributedTo(w, r, subscriberID)
		if !attrOK {
			return
		}
		subscriberID = attrWho
		wait, err := h.bs.GetActiveWait(r.Context(), project, subscriberID)
		if err != nil {
			errInternalServer(w, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"wait": wait})
		return
	}
	waits, err := h.bs.ListActiveWaits(r.Context(), project)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"waits": waits})
}

// CancelWait cancels an active wait for a subscriber.
// DELETE /api/board/{project}/waits
func (h *BoardHandler) CancelWait(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	subscriberID := r.URL.Query().Get("subscriber_id")
	if subscriberID == "" {
		var body struct {
			SubscriberID string `json:"subscriber_id"`
		}
		_ = decodeJSON(r, &body)
		subscriberID = body.SubscriberID
	}
	attrWho, attrOK := attributedTo(w, r, subscriberID)
	if !attrOK {
		return
	}
	subscriberID = attrWho
	if subscriberID == "" {
		errBadRequest(w, "subscriber_id required")
		return
	}
	if err := h.bs.CancelActiveWait(r.Context(), project, subscriberID); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
}

// PollWait long-polls until an active wait is resolved, expired, or cancelled.
// GET /api/board/{project}/waits/poll
func (h *BoardHandler) PollWait(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	subscriberID, attrOK := attributedTo(w, r, r.URL.Query().Get("subscriber_id"))
	if !attrOK {
		return
	}
	if subscriberID == "" {
		errBadRequest(w, "subscriber_id required")
		return
	}
	timeoutSec := 30
	if raw := r.URL.Query().Get("timeout"); raw != "" {
		if sec, err := strconv.Atoi(raw); err == nil && sec > 0 {
			if sec > 60 {
				sec = 60
			}
			timeoutSec = sec
		}
	}
	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)

	// Sleep until a wait changes in the store (resolve, cancel, expiry), the
	// wait's own expiry, or the deadline, instead of querying every 500ms per
	// waiter. waitPollRecheck is a safety net for a change the signal missed.
	for {
		changed := h.bs.WaitsChanged() // before the read, so no change slips between
		wait, err := h.bs.GetActiveWait(r.Context(), project, subscriberID)
		if err != nil {
			errInternalServer(w, err.Error())
			return
		}
		if wait == nil {
			writeJSON(w, http.StatusOK, map[string]any{"status": "resolved"})
			return
		}
		now := time.Now()
		if now.After(deadline) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "timeout", "wait": wait})
			return
		}
		next := min(deadline.Sub(now), waitPollRecheck)
		if expires, err := time.Parse(time.RFC3339, wait.ExpiresAt); err == nil {
			// GetActiveWait expires it once the second has passed.
			next = min(next, expires.Add(time.Second).Sub(now))
		}
		timer := time.NewTimer(max(next, 10*time.Millisecond))
		select {
		case <-r.Context().Done():
			timer.Stop()
			return
		case <-changed:
		case <-timer.C:
		}
		timer.Stop()
	}
}

// waitPollRecheck bounds how long a long-poll sleeps without re-reading its
// wait, in case a change did not signal (for example, an older writer).
var waitPollRecheck = 5 * time.Second

func (h *BoardHandler) resolveMessageWaits(project, senderID, content string) {
	ctx := context.Background()
	resolved, err := h.bs.ResolveMatchingMessageWaits(ctx, project, senderID, content)
	if err != nil || len(resolved) == 0 {
		return
	}
	for _, w := range resolved {
		sessionName := w.SessionName
		if sub, err := h.bs.GetProjectSubscription(ctx, project, w.SubscriberID); err == nil && sub != nil && sub.SessionName != "" {
			sessionName = sub.SessionName
		}
		if h.terminal != nil && sessionName != "" {
			// No preview: the message is read on the board (typedMessageWaitResolved, goal #7).
			nudge := typedMessageWaitResolved(senderID, project)
			if err := h.sendAutomated(ctx, project, sessionName, nudge); err != nil {
				slog.Warn("failed to nudge waiting agent", "subscriber", w.SubscriberID, "session", sessionName, "error", err)
			}
		}
	}
}

func (h *BoardHandler) resolveTaskWaits(project string, taskID int64, taskTitle, event string) {
	ctx := context.Background()
	resolved, err := h.bs.ResolveMatchingTaskWaits(ctx, project, taskID)
	if err != nil || len(resolved) == 0 {
		return
	}
	for _, w := range resolved {
		sessionName := w.SessionName
		if sub, err := h.bs.GetProjectSubscription(ctx, project, w.SubscriberID); err == nil && sub != nil && sub.SessionName != "" {
			sessionName = sub.SessionName
		}
		if h.terminal != nil && sessionName != "" {
			nudge := typedTaskWaitResolved(taskID, taskTitle, event)
			if err := h.sendAutomated(ctx, project, sessionName, nudge); err != nil {
				slog.Warn("failed to nudge waiting agent", "subscriber", w.SubscriberID, "session", sessionName, "error", err)
			}
		}
	}
}

// endOwnWaits ends the registered waits of an agent that is plainly not parked: it posted, claimed a task or completed one (#7765). A wait parks an agent until the thing it waits for happens;
// an agent woken by anything else (a task nudge, the Operator) and working again would otherwise keep "waiting for a message from the Orchestrator" in the status and the health check until it ran
// coral-board wait --cancel. An error is only logged: the action itself has happened.
func (h *BoardHandler) endOwnWaits(ctx context.Context, project, subscriberID string) {
	if subscriberID == "" {
		return
	}
	h.keepExpiredOperatorQuestions(ctx, project)                  // a wait that ran out and nobody noticed yet is cancelled below: keep its question first (#11919)
	asked := h.activeOperatorQuestion(ctx, project, subscriberID) // an unanswered question to the Operator outlives the agent getting back to work (#11919)
	if err := h.bs.CancelActiveWait(ctx, project, subscriberID); err != nil {
		slog.Warn("could not end the waits of an agent that is working", "project", project, "subscriber", subscriberID, "error", err)
		return
	}
	if asked != nil {
		h.keepReplacedOperatorQuestion(ctx, project, asked)
	}
}

// activeOperatorQuestion is the agent's active wait when it is a question to the Operator with its text, else nil: the one thing a wait that ends for any reason but the Operator's answer or the agent's own
// `wait --cancel` must not take out of Needs you (#11919).
func (h *BoardHandler) activeOperatorQuestion(ctx context.Context, project, subscriberID string) *board.RegisteredWait {
	w, err := h.bs.GetActiveWait(ctx, project, subscriberID)
	if err != nil || w == nil || w.WaitType != board.WaitOperator || strings.TrimSpace(w.Reason) == "" {
		return nil
	}
	return w
}

// keepReplacedOperatorQuestion makes the question of a wait that ended unanswered an ordinary open question (an ask of the Operator, from the same agent) so it stays in Needs you until it is answered or closed
// like any other (#11919). It returns the error when the question could not be kept, and nil when it was or already is. A failure never fails the agent's own call (its new wait, its post): the callers log it, and
// the expiry path gives its claim back so the next read tries again.
func (h *BoardHandler) keepReplacedOperatorQuestion(ctx context.Context, project string, old *board.RegisteredWait) error {
	keep := h.keepQuestion
	if keep == nil {
		keep = h.postKeptQuestion
	}
	if err := keep(ctx, project, old); err != nil {
		slog.Warn("[wait] question not kept", "board", project, "agent", old.SubscriberID, "error", err)
		return err
	}
	return nil
}

// postKeptQuestion is the keeping itself: posts the question as an ask of the Operator unless an open ask of the agent already says it.
func (h *BoardHandler) postKeptQuestion(ctx context.Context, project string, old *board.RegisteredWait) error {
	reason := strings.TrimSpace(old.Reason)
	// The same question is not kept twice: the agent asked it with post --ask too, a re-issued wait carried it already, or the new wait is the same question (a trailing space is not a new question).
	if asks, err := h.bs.OpenAsksOf(ctx, project, board.OperatorName, time.Now()); err == nil {
		for _, a := range asks {
			if strings.EqualFold(a.Asker, old.SubscriberID) && strings.EqualFold(askQuestionText(a.Content), reason) {
				return nil
			}
		}
	}
	msg, err := h.bs.PostMessage(ctx, project, old.SubscriberID, "@Operator (an earlier question, still open) "+reason, nil)
	if err == nil {
		err = h.bs.RecordAsk(ctx, project, msg, []string{board.OperatorName})
	}
	if err != nil {
		return err
	}
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
	return nil
}

// askQuestionText is an ask's question without the @Operator it opens with and without the "earlier question" frame this file adds: what two asks are compared by (a whole question, never a part of one).
func askQuestionText(content string) string {
	t := strings.TrimSpace(content)
	t = strings.TrimSpace(strings.TrimPrefix(t, "@"+board.OperatorName))
	t = strings.TrimSpace(strings.TrimPrefix(t, "(an earlier question, still open)"))
	return strings.TrimSpace(t)
}

// keepExpiredOperatorQuestions keeps, once, the questions whose operator wait ran out unanswered on this board (#11919): read when the Operator's Needs you is read. A question kept by the claim is an ask
// like any other from then on.
func (h *BoardHandler) keepExpiredOperatorQuestions(ctx context.Context, project string) {
	waits, err := h.bs.ExpiredOperatorQuestions(ctx, project)
	if err != nil {
		return
	}
	for i := range waits {
		if won, err := h.bs.ClaimExpiredQuestion(ctx, waits[i].ID); err != nil || !won {
			continue
		}
		if err := h.keepReplacedOperatorQuestion(ctx, project, &waits[i]); err != nil {
			h.bs.UnclaimExpiredQuestion(ctx, waits[i].ID) // not kept: the next read tries again
		}
	}
}
