// What waits for a live agent, and Send now (#7727, replacing the held queue of #7554): with no queue, what waits for an agent is its unread board messages and the last
// automated send Coral did not type, and why. Operator-only (an agent's token is refused: an agent cannot push text into another), never through the Hub.

package routes

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/terminalinput"
)

// maxWaitingMessages and maxWaitingText bound the list: the page shows the newest messages and expands one to its text.
const (
	maxWaitingMessages = 50
	maxWaitingText     = 4000
)

type waitingMessage struct {
	ID     int64  `json:"id"`
	Sender string `json:"sender"`
	At     string `json:"at"`
	Text   string `json:"text"`
	// Truncated: the text was cut at maxWaitingText.
	Truncated bool `json:"truncated,omitempty"`
}

type skippedRow struct {
	Why   string `json:"why"`
	What  string `json:"what"`
	At    string `json:"at"`
	Since string `json:"since"`
}

// skippedWhy is why the last send to the session was not typed, for the 202 answers of the automated HTTP senders.
func skippedWhy(name string) string {
	if s, ok := ptymanager.SkippedOf(name); ok {
		return s.Why
	}
	return "the agent's screen showed a prompt, a draft or could not be read"
}

// waitingUnread is the unread count ListWaiting has put in out.
func waitingUnread(out map[string]any) int {
	n, _ := out["unread"].(int)
	return n
}

// agentMayReachWaiting is the handler's half of the Orchestrator's use of the waiting routes (#8558; the identity layer's half is orchestratorOwnBoardRoutes): a request from an agent's token (which the
// identity layer let through only for an active registered orchestrator) is for a target on the caller's own board, and nothing else; a request with no agent's token (the Operator's dashboard and
// command line) is not asked. It answers the refusal itself. target is the exact session name.
func (h *SessionsHandler) agentMayReachWaiting(w http.ResponseWriter, r *http.Request, target string) bool {
	owner, agent := VerifiedSession(r.Context())
	if !agent {
		return true
	}
	deny := func() bool {
		errForbidden(w, "An agent can't use this for an agent of another team: an Orchestrator may use it for the agents of its own team")
		return false
	}
	if h.bs == nil {
		return deny()
	}
	caller, err := h.bs.GetSubscriptionBySessionName(r.Context(), owner.SessionName)
	if err != nil || caller == nil || h.bs.RequireTaskReviewer(r.Context(), caller.Project, caller.SubscriberID) != nil {
		return deny() // not an active registered orchestrator (a path the identity layer already closes; checked again here)
	}
	mine, err := h.bs.GetSubscriptionBySessionName(r.Context(), target)
	if err != nil || mine == nil || mine.Project != caller.Project {
		return deny()
	}
	return true
}

// ListWaiting lists what waits for one live agent: its unread board messages (sender, time, text) and the last automated send that was not typed, with why.
// GET /api/sessions/live/{name}/waiting?agent_type=..&session_id=..
//
//	{"board": "team", "unread": N, "messages": [{"id", "sender", "at", "text", "truncated"?}], "skipped": {"why", "what", "at", "since"} | null}
func (h *SessionsHandler) ListWaiting(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	ls, status, message := h.validateExactLiveTarget(r.Context(), name, r.URL.Query().Get("agent_type"), r.URL.Query().Get("session_id"), false)
	if status != 0 {
		writeExactTargetError(w, status, message)
		return
	}
	// The dashboard names the folder; board subscriptions and terminal state use the exact session name.
	name = naming.SessionName(ls.AgentType, ls.SessionID)
	if !h.agentMayReachWaiting(w, r, name) {
		return
	}
	out := map[string]any{"board": nil, "unread": 0, "messages": []waitingMessage{}, "skipped": nil}
	if h.bs != nil {
		if sub, err := h.bs.GetSubscriptionBySessionName(r.Context(), name); err == nil && sub != nil {
			out["board"] = sub.Project
			if n, err := h.bs.CheckUnread(r.Context(), sub.Project, sub.SubscriberID); err == nil {
				out["unread"] = n
			}
			if msgs, err := h.bs.PeekMessages(r.Context(), sub.Project, sub.SubscriberID, maxWaitingMessages); err == nil { // a look, not a read: the agent keeps them unread
				rows := make([]waitingMessage, 0, len(msgs))
				for _, m := range msgs {
					text, cut := clitext.Clean(m.Content), false
					if len(text) > maxWaitingText {
						text, cut = text[:maxWaitingText], true
					}
					rows = append(rows, waitingMessage{ID: m.ID, Sender: m.SubscriberID, At: m.CreatedAt, Text: text, Truncated: cut})
				}
				out["messages"] = rows
			}
		}
	}
	out["skipped"] = skippedSendField(name, waitingUnread(out)) // none when no unread board message waits
	writeJSON(w, http.StatusOK, out)
}

// SendWaitingNow types the board nudge for one live agent at once, as a person's own action: the one look at the screen of an automated send is not made, except that nothing is typed
// into a prompt that is open or added to text in the input box that is not Coral's (the agent may be in the middle of a turn: the text is typed into its input box and the CLI queues it).
// POST /api/sessions/live/{name}/waiting/send  {"agent_type":..,"session_id":..}
func (h *SessionsHandler) SendWaitingNow(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var body struct {
		AgentType string `json:"agent_type"`
		SessionID string `json:"session_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	ls, status, message := h.validateExactLiveTarget(r.Context(), name, body.AgentType, body.SessionID, false)
	if status != 0 {
		writeExactTargetError(w, status, message)
		return
	}
	name = naming.SessionName(ls.AgentType, ls.SessionID)
	if !h.agentMayReachWaiting(w, r, name) {
		return
	}
	if h.bs == nil {
		errBadRequest(w, "no board")
		return
	}
	sub, err := h.bs.GetSubscriptionBySessionName(r.Context(), name)
	if err != nil || sub == nil {
		errBadRequest(w, "this agent is not on a board")
		return
	}
	unread, _ := h.bs.CheckUnread(r.Context(), sub.Project, sub.SubscriberID)
	if unread <= 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sent": false, "nothing_waiting": true})
		return
	}
	text := board.NudgeText(unread)
	delivery, err := ptymanager.DeliverNow(r.Context(), ptymanager.AutomatedInput{
		Term: h.terminal, Name: name, AgentType: ls.AgentType, SessionID: ls.SessionID,
		Key: "board-unread:" + sub.Project, Text: text, What: "Send now", Paste: true,
		Send: func(ctx context.Context) error {
			return h.terminal.SendInput(ctx, terminalinput.Coral, name, text, ls.AgentType, ls.SessionID)
		},
	})
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	out := map[string]any{"ok": true, "sent": delivery == ptymanager.Sent}
	if delivery == ptymanager.Skipped {
		if s, ok := ptymanager.SkippedOf(name); ok {
			out["why"] = s.Why
			out["prompt_open"] = len(s.Why) >= len(ptymanager.SkipPrompt) && s.Why[:len(ptymanager.SkipPrompt)] == ptymanager.SkipPrompt
			out["draft_in_box"] = s.Why == ptymanager.SkipDraft
		} else {
			out["sent"] = true // no skip was recorded: Coral's own earlier nudge was still in the box and got its Enter now
		}
	}
	writeJSON(w, http.StatusOK, out)
}
