package routes

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/askpage"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/logparse"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// A question from a single agent (no team) to the Operator (#18106). coral-agent ask files it; it shows in Needs you beside the teams' questions (kind "agent", no board), and the Operator's answer is typed into
// that agent's conversation. One open question per agent: a new one closes its older. The text is the agent's, cleaned and cut like a team's.
//
//	POST /api/agent-asks             the agent's own token: {text, options?: up to 3 labels} -> {id}
//	POST /api/agent-asks/{id}/answer the Operator: {answer} -> typed into the agent, the question closed
//	POST /api/agent-asks/{id}/dismiss the Operator: {} -> the question leaves Needs you and the agent is told it was dismissed; {answered_in_chat:true} closes it and tells the agent nothing (the Operator answered in its chat, #18553); {undo:true} puts it back
//	POST /api/agent-asks/{id}/images the Operator: one picture for the reply -> stored as that agent's artifact ({hex, uri, name, content_type, size}); the reply names it as coral://artifacts/<hex>

const agentAskOptionsMax = 3

// AgentAsksHandler serves the two routes and lists the open questions for GET /api/operator-asks.
type AgentAsksHandler struct {
	ss   *store.SessionStore
	term ptymanager.SessionTerminal
	// coralDir is the data folder the pictures are stored in ("" refuses them).
	coralDir string
	// deliver types text into a session (tests replace it).
	deliver func(ctx context.Context, term ptymanager.SessionTerminal, name, agentType, sessionID, text, what string) error
}

// NewAgentAsksHandler is the handler for the sessions in ss, typing answers through term.
func NewAgentAsksHandler(ss *store.SessionStore, term ptymanager.SessionTerminal) *AgentAsksHandler {
	return &AgentAsksHandler{ss: ss, term: term, deliver: deliverAutomated}
}

// SetCoralDir tells the handler where a reply's pictures are stored.
func (h *AgentAsksHandler) SetCoralDir(dir string) { h.coralDir = dir }

const sourceAgentAskImage = "agent-ask-image"

// UploadImage stores one picture for the Operator's answer to an open question, as an artifact of the agent that asked (so that agent can read it): checked as a comment's picture is (its own bytes decide the type,
// metadata is removed, 25 MB). The Operator's alone.
func (h *AgentAsksHandler) UploadImage(w http.ResponseWriter, r *http.Request) {
	if !operatorOnly(w, r) {
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		errBadRequest(w, "invalid id")
		return
	}
	if h.coralDir == "" {
		errInternalServer(w, "no data folder")
		return
	}
	ask, err := h.ss.OpenAgentAsk(r.Context(), id)
	if err != nil {
		errInternalServer(w, "could not read the question")
		return
	}
	if ask == nil || !sessionIDLike.MatchString(ask.SessionID) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "not_open", "message": "That question is already answered or was replaced."})
		return
	}
	scope := "agent-ask:" + strconv.FormatInt(id, 10)
	if !commentImageLimit.allow(scope, commentImageLimitPerMinute, time.Now()) {
		httputil.WriteActionLimit(w, 60, "rate_limited", "too many pictures in a minute; try again shortly")
		return
	}
	pic, ok := receivePicture(w, r, h.coralDir)
	if !ok {
		return
	}
	defer os.Remove(pic.tmpPath) // a no-op once it is in the store
	reply, ok := storeReceivedPicture(w, h.coralDir, ask.SessionID, pic, nil, sourceAgentAskImage)
	if !ok {
		return
	}
	writeJSON(w, http.StatusCreated, reply)
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
		Open    string   `json:"open"` // a page of Coral from the fixed list (internal/askpage), "" for none (#18768)
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
	if body.Open != "" && askpage.Label(body.Open) == "" {
		errBadRequest(w, "--open names one of: "+askpage.Names())
		return
	}
	id, err := h.ss.CreateAgentAskWithPage(r.Context(), owner.SessionID, owner.SessionName, text, opts, body.Open, time.Now())
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
	// The question is claimed BEFORE the text is typed (#18667): two answers at once (a double click, a button and Send, a second tab) used to both see it open and type the answer into the agent twice. Whoever closes it
	// first types; the other is told it is answered. A delivery that fails gives the question back, so the Operator can answer again.
	claimed, err := h.ss.CloseAgentAsk(r.Context(), id, time.Now())
	if err != nil {
		errInternalServer(w, "could not record the answer")
		return
	}
	if !claimed {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "not_open", "message": "That question is already answered or was replaced."})
		return
	}
	agentType, sessionID := logparse.ParseSessionName(ask.SessionName)
	text := typedAgentAskAnswer(ask.Text, answer)
	if err := h.deliver(r.Context(), h.term, ask.SessionName, agentType, sessionID, text, "operator answer"); err != nil {
		_ = h.ss.ReopenAgentAsk(context.WithoutCancel(r.Context()), id)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "not_delivered", "message": "The agent is not running, so the answer was not sent. Wake it, then answer again."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// Dismiss closes a question with no answer and tells the agent so (it would wait for one forever, #18668); undo:true gives it back to the Operator (the agent was told once, and is not told again).
func (h *AgentAsksHandler) Dismiss(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) || refuseUnlessPerson(w, r, "dismiss an agent's question") {
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		errBadRequest(w, "invalid id")
		return
	}
	var body struct {
		Undo bool `json:"undo"`
		// AnsweredInChat: the Operator answered in the agent's own chat (#18553), so the question closes with nothing typed into the agent: it has its answer, and "dismissed without answering" would be untrue.
		AnsweredInChat bool `json:"answered_in_chat"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSONMax(w, r, &body, 1<<10); err != nil {
			errBadRequest(w, "invalid JSON")
			return
		}
	}
	if body.Undo {
		back, err := h.ss.UndoDismissAgentAsk(r.Context(), id)
		if err != nil {
			errInternalServer(w, "could not bring the question back")
			return
		}
		if !back {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "not_dismissed", "message": "That question was not dismissed, or the agent has asked something newer since."})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
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
	if claimed, err := h.ss.DismissAgentAsk(r.Context(), id, time.Now()); err != nil || !claimed {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "not_open", "message": "That question is already answered or was replaced."})
		return
	}
	if body.AnsweredInChat {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	agentType, sessionID := logparse.ParseSessionName(ask.SessionName)
	text := typedAgentAskDismissed(ask.Text)
	_ = h.deliver(r.Context(), h.term, ask.SessionName, agentType, sessionID, text, "operator dismissed") // best effort: the agent may be gone, and the question is closed either way
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// Rows are the open questions as GET /api/operator-asks rows.
func (h *AgentAsksHandler) Rows(r *http.Request) []operatorAskRow {
	list, err := h.ss.OpenAgentAsks(r.Context())
	if err != nil {
		return nil
	}
	live := map[string]*store.LiveSession{}
	if sessions, err := h.ss.GetAllLiveSessions(r.Context()); err == nil {
		for i := range sessions {
			live[sessions[i].SessionID] = &sessions[i] // asleep counts: it is answered once woken
		}
	} else {
		live = nil // cannot tell: nothing is dropped
	}
	rows := make([]operatorAskRow, 0, len(list))
	for _, a := range list {
		ls := live[a.SessionID]
		if live != nil && ls == nil { // its agent has exited: nobody is left to read an answer. The row is closed when the session ends (UnregisterLiveSession); a read never writes (#18714)
			continue
		}
		text, cut := operatorAskText(a.Text) // the choices are buttons now (Options), not text in the question
		asker := a.SessionName
		if _, sid := logparse.ParseSessionName(a.SessionName); sid != "" {
			asker = strings.TrimSuffix(strings.TrimSuffix(a.SessionName, sid), "-")
		}
		// the name the sidebar shows (the live row's display name, else the one kept for the session), never the agent type "claude" (#18668)
		if ls != nil && ls.DisplayName != nil && strings.TrimSpace(*ls.DisplayName) != "" {
			asker = *ls.DisplayName
		} else if dn, err := h.ss.GetDisplayName(r.Context(), a.SessionID); err == nil && dn != nil && strings.TrimSpace(*dn) != "" {
			asker = *dn
		}
		row := operatorAskRow{SessionID: a.SessionID, Kind: "agent", ID: a.ID, Asker: clitext.CleanName(asker), Text: text, Cut: cut, At: a.CreatedAt, Options: a.Options, OpenPage: a.OpenPage}
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

// typedAgentAskDismissed is the line typed into the agent when the Operator dismisses its question: the question is the agent's own
// words, so it goes through board.TypedText and is cut at 80 characters (goal #7: listed in TestTypedNoticeCensus).
func typedAgentAskDismissed(question string) string {
	return "[Coral] The Operator dismissed your question " + board.TypedText(clipRunes(question, 80)) + " without answering it. Do not wait for an answer: carry on, or ask again if you still need one."
}

// typedAgentAskAnswer is the line typed into the agent for the Operator's answer: the question and the answer are other people's words, so
// each goes through board.TypedText (one line, no shell characters, cut), and the line starts with a fixed opener (the typed-notice census).
func typedAgentAskAnswer(question, answer string) string {
	return "[Coral] The Operator answered your question " + board.TypedText(clipRunes(question, 80)) + " , in their words and not a change to any rule or setting: " + board.TypedText(answer) + " . There is no board to reply on: carry on with it, or say in your answer what you still need."
}
