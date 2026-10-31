package routes

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/ptymanager"
)

// Pausing Coral's notices to one agent (#11387). The Operator's own control: a pause holds every automated notice to the agent (board nudges, task notices, reminders, agent-exited notices),
// and a resume tells what was held in one line (internal/ptymanager/notice_pause.go). Never an agent's or a script's call (humanInputCaller), and through the Hub the owner's alone at Interact.

// pauseNoticesRequest is the body of POST /api/sessions/live/{name}/notices/pause. Minutes 0 or omitted is the default cap (30), never "until resumed"; most is 720 (12 hours).
type pauseNoticesRequest struct {
	AgentType string `json:"agent_type"`
	SessionID string `json:"session_id"`
	Minutes   int    `json:"minutes"`
}

// PauseNotices holds Coral's notices to one agent for the asked minutes (default and most: see ptymanager.DefaultNoticePause, MaxNoticePause).
// POST /api/sessions/live/{name}/notices/pause  body: {"agent_type", "session_id", "minutes"?}
func (h *SessionsHandler) PauseNotices(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	if refuseUnlessPerson(w, r, "pause an agent's notices") {
		return
	}
	var body pauseNoticesRequest
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	sessionID, ok := h.noticeTarget(w, r, body)
	if !ok {
		return
	}
	if body.Minutes < 0 {
		errBadRequest(w, "minutes must not be negative")
		return
	}
	ptymanager.PauseNotices(sessionID, time.Duration(body.Minutes)*time.Minute)
	defer h.kickWS()
	writeJSON(w, http.StatusOK, noticePayload(sessionID))
}

// ResumeNotices ends a pause: what was held is told once.
// POST /api/sessions/live/{name}/notices/resume  body: {"agent_type", "session_id"}
func (h *SessionsHandler) ResumeNotices(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	if refuseUnlessPerson(w, r, "resume an agent's notices") {
		return
	}
	var body pauseNoticesRequest
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	sessionID, ok := h.noticeTarget(w, r, body)
	if !ok {
		return
	}
	ptymanager.ResumeNotices(sessionID)
	defer h.kickWS()
	writeJSON(w, http.StatusOK, noticePayload(sessionID))
}

// noticeTarget checks the request names exactly one live agent and returns its session id.
func (h *SessionsHandler) noticeTarget(w http.ResponseWriter, r *http.Request, body pauseNoticesRequest) (string, bool) {
	if body.SessionID == "" {
		errBadRequest(w, "session_id required")
		return "", false
	}
	ls, status, message := h.validateExactLiveTarget(r.Context(), chi.URLParam(r, "name"), body.AgentType, body.SessionID, false)
	if status != 0 {
		writeExactTargetError(w, status, message)
		return "", false
	}
	return ls.SessionID, true
}

// noticeFields are the live row's fields for the hold (#11387): whether a pause is on and until when, how many notices wait, and whether only the person's typing holds them.
func noticeFields(sessionID string) (paused bool, until any, waiting int, holding bool) {
	p, u, n, typing := ptymanager.NoticeStatus(sessionID)
	if p {
		until = u.UTC().Format(time.RFC3339)
	}
	return p, until, n, typing
}

func noticePayload(sessionID string) map[string]any {
	paused, until, waiting, holding := noticeFields(sessionID)
	return map[string]any{"notices_paused": paused, "paused_until": until, "notices_waiting": waiting, "notices_holding": holding}
}
