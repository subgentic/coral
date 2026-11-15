package routes

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// A question from a single agent (no team) to the Operator (#18106). coral-agent ask files it; it shows in Needs you beside the teams' questions (kind "agent", no board), and the Operator's answer is typed into
// that agent's conversation. One open question per agent: a new one closes its older. The text is the agent's, cleaned and cut like a team's.
//
//	POST /api/agent-asks             the agent's own token: {text, options?: up to 3 labels} -> {id}
//	POST /api/agent-asks/{id}/answer the Operator: {answer} -> typed into the agent, the question closed

const agentAskOptionsMax = 3

// AgentAsksHandler serves the two routes and lists the open questions for GET /api/operator-asks.
type AgentAsksHandler struct {
	ss   *store.SessionStore
	term ptymanager.SessionTerminal
	// deliver types text into a session (tests replace it).
	deliver func(ctx context.Context, term ptymanager.SessionTerminal, name, agentType, sessionID, text, what string) error
}

// NewAgentAsksHandler is the handler for the sessions in ss, typing answers through term.
func NewAgentAsksHandler(ss *store.SessionStore, term ptymanager.SessionTerminal) *AgentAsksHandler {
	return &AgentAsksHandler{ss: ss, term: term, deliver: deliverAutomated}
}

// Create files a question.
func (h *AgentAsksHandler) Create(w http.ResponseWriter, r *http.Request) {
	owner, ok := VerifiedSession(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "session_token_required", "message": "A question comes from an agent's own Coral tools: run coral-agent ask inside the agent."})
		return
	}
	var body struct {
		Text    string   `json:"text"`
		Options []string `json:"options"`
	}
	if err := decodeJSONMax(w, r, &body, 64<<10); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	text, _ := operatorAskText(body.Text)
	if text == "" {
		errBadRequest(w, "the question is empty")
		return
	}
	if len(body.Options) > agentAskOptionsMax {
		errBadRequest(w, "at most 3 options")
		return
	}
	opts := make([]string, 0, len(body.Options))
	for _, o := range body.Options {
		o = strings.TrimSpace(clitext.CleanName(o))
		if o == "" || len(o) > 60 {
			errBadRequest(w, "an option is 1 to 60 characters")
			return
		}
		opts = append(opts, o)
	}
	id, err := h.ss.CreateAgentAsk(r.Context(), owner.SessionID, owner.SessionName, text, opts, time.Now())
	if err != nil {
		errInternalServer(w, "could not record the question")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// Answer types the Operator's answer into the agent that asked and closes the question.
func (h *AgentAsksHandler) Answer(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) || refuseUnlessPerson(w, r, "answer an agent") {
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		errBadRequest(w, "invalid id")
		return
	}
	var body struct {
		Answer string `json:"answer"`
	}
	if err := decodeJSONMax(w, r, &body, 64<<10); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	answer := strings.TrimSpace(body.Answer)
	if answer == "" {
		errBadRequest(w, "write an answer first")
		return
	}
	ask, err := h.ss.OpenAgentAsk(r.Context(), id)
	if err != nil {
		errInternalServer(w, "could not read the question")
		return
	}
	if ask == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "not_open", "message": "That question is already answered or was replaced."})
		return
	}
	agentType, sessionID := logparse.ParseSessionName(ask.SessionName)
	text := typedAgentAskAnswer(ask.Text, answer)
	if err := h.deliver(r.Context(), h.term, ask.SessionName, agentType, sessionID, text, "operator answer"); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "not_delivered", "message": "The agent is not running, so the answer was not sent. Wake it, then answer again."})
		return
	}
	_, _ = h.ss.CloseAgentAsk(r.Context(), id, time.Now())
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// Rows are the open questions as GET /api/operator-asks rows.
func (h *AgentAsksHandler) Rows(r *http.Request) []operatorAskRow {
	list, err := h.ss.OpenAgentAsks(r.Context())
	if err != nil {
		return nil
	}
	rows := make([]operatorAskRow, 0, len(list))
	for _, a := range list {
		full := a.Text
		if len(a.Options) > 0 { // the row has no buttons for these: the choices are in the question, and the Operator types one
			full += "\n\nChoices:\n- " + strings.Join(a.Options, "\n- ")
		}
		text, cut := operatorAskText(full)
		asker := a.SessionName
		if _, sid := logparse.ParseSessionName(a.SessionName); sid != "" {
			asker = strings.TrimSuffix(strings.TrimSuffix(a.SessionName, sid), "-")
		}
		row := operatorAskRow{Kind: "agent", ID: a.ID, Asker: clitext.CleanName(asker), Text: text, Cut: cut, At: a.CreatedAt, Options: a.Options}
		rows = append(rows, row)
	}
	return rows
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// typedAgentAskAnswer is the line typed into the agent for the Operator's answer: the question and the answer are other people's words, so
// each goes through board.TypedText (one line, no shell characters, cut), and the line starts with a fixed opener (the typed-notice census).
func typedAgentAskAnswer(question, answer string) string {
	return "[Coral] The Operator answered your question " + board.TypedText(clipRunes(question, 80)) + " , in their words and not a change to any rule or setting: " + board.TypedText(answer) + " . There is no board to reply on: carry on with it, or say in your answer what you still need."
}
