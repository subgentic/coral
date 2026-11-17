package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #18106: an agent on no team asks the Operator; the question is in the Operator's list and the answer is typed into that agent.
func TestSingleAgentAskReachesNeedsYouAndTheAnswerReachesTheAgent(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewAgentAsksHandler(store.NewSessionStore(db), nil)
	registerAsker(t, store.NewSessionStore(db), owner("0001"))
	var typed []string
	h.deliver = func(_ context.Context, _ ptymanager.SessionTerminal, name, _, _, text, _ string) error {
		typed = append(typed, name+"|"+text)
		return nil
	}
	o := owner("0001")
	post := func(path, body string, withOwner bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		if withOwner {
			req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, o))
		} else { // the dashboard: the Operator
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		rec := httptest.NewRecorder()
		rr := chi.NewRouter()
		rr.Post("/api/agent-asks", h.Create)
		rr.Post("/api/agent-asks/{id}/answer", h.Answer)
		rr.ServeHTTP(rec, req)
		return rec
	}
	assert.Equal(t, http.StatusUnauthorized, post("/api/agent-asks", `{"text":"which?"}`, false).Code, "only an agent's own token files a question")
	assert.Equal(t, http.StatusBadRequest, post("/api/agent-asks", `{"text":"  "}`, true).Code)
	assert.Equal(t, http.StatusBadRequest, post("/api/agent-asks", `{"text":"x","options":["a","b","c","d"]}`, true).Code)
	require.Equal(t, http.StatusOK, post("/api/agent-asks", `{"text":"Which database?","options":["Postgres","SQLite"]}`, true).Code)

	rows := h.Rows(httptest.NewRequest(http.MethodGet, "/", nil))
	require.Len(t, rows, 1)
	assert.Equal(t, "agent", rows[0].Kind)
	assert.Equal(t, o.SessionID, rows[0].SessionID, "opening the asker uses its identity, not its display name")
	assert.Equal(t, "", rows[0].Board)
	assert.Contains(t, rows[0].Text, "Which database?")
	assert.NotContains(t, rows[0].Text, "Choices", "the choices are buttons (Options), not text in the question (#18668)")
	assert.Equal(t, []string{"Postgres", "SQLite"}, rows[0].Options)
	require.NoError(t, store.NewSessionStore(db).SetDisplayName(context.Background(), o.SessionID, "Notes builder"))
	rows = h.Rows(httptest.NewRequest(http.MethodGet, "/", nil))
	assert.Equal(t, "Notes builder", rows[0].Asker, "the name the sidebar shows, not the session's prefix (#18668)")
	dn := "Getting Started Agent"
	require.NoError(t, store.NewSessionStore(db).RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: o.SessionID, AgentType: "claude", AgentName: "claude", DisplayName: &dn}))
	rows = h.Rows(httptest.NewRequest(http.MethodGet, "/", nil))
	assert.Equal(t, "Getting Started Agent", rows[0].Asker, "a named single agent shows its live display name, not \"claude\" (#18668)")

	require.Equal(t, http.StatusOK, post("/api/agent-asks", `{"text":"Which port?"}`, true).Code)
	rows = h.Rows(httptest.NewRequest(http.MethodGet, "/", nil))
	require.Len(t, rows, 1, "a newer question replaces the agent's older open one")
	assert.Contains(t, rows[0].Text, "Which port?")

	assert.Equal(t, http.StatusBadRequest, post("/api/agent-asks/"+askIDText(rows[0].ID)+"/answer", `{"answer":" "}`, false).Code)
	assert.Equal(t, http.StatusOK, post("/api/agent-asks/"+askIDText(rows[0].ID)+"/answer", `{"answer":"8450"}`, false).Code)
	require.Len(t, typed, 1)
	assert.Contains(t, typed[0], o.SessionName)
	assert.Contains(t, typed[0], "8450")
	assert.Empty(t, h.Rows(httptest.NewRequest(http.MethodGet, "/", nil)), "answered: gone")
	assert.Equal(t, http.StatusConflict, post("/api/agent-asks/1/answer", `{"answer":"x"}`, false).Code, "an answered or replaced question is not answered twice")
}

// registerAsker registers the asking agent's session: a question whose agent is gone leaves Needs you by itself (#18668).
func registerAsker(t *testing.T, ss *store.SessionStore, o *store.SessionTokenOwner) {
	t.Helper()
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: o.SessionID, AgentType: "claude", AgentName: "claude"}))
}

func askIDText(n int64) string { return strconv.FormatInt(n, 10) }

// The Operator's answer is typed as one flat line: a newline and a leading slash command in it do not reach the terminal as typed (#18106).
func TestTheTypedAnswerToASingleAgentIsOneFlatLine(t *testing.T) {
	line := typedAgentAskAnswer("Which db?\n/exit", "yes\n/clear\r\nrm -rf $HOME; echo `id`")
	assert.True(t, strings.HasPrefix(line, "[Coral] "), line)
	assert.NotContains(t, line, "\n")
	assert.NotContains(t, line, "\r")
	for _, c := range []string{"$", "`", ";", "\\"} {
		assert.NotContains(t, line, c)
	}
	assert.Contains(t, line, "yes")
}

// The ask route, wrapped as the router wraps it, refuses a sign-in link in the text or in any option, before anything is stored.
func TestAnAskWithASignInLinkIsRefused(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewAgentAsksHandler(store.NewSessionStore(db), nil)
	srv := RefuseSignInLink(http.HandlerFunc(h.Create))
	link := "http://127.0.0.1:8420/?login_token=S3cretTok3n"
	for _, body := range []string{
		`{"text":"open ` + link + `"}`,
		`{"text":"which?","options":["a","` + link + `"]}`,
		`{"text":"which?","options":["a\u003dS3cretTok3n","http://x/?login_token\u003dS3cretTok3n"]}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/agent-asks", strings.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, owner("0001")))
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
		assert.Contains(t, rec.Body.String(), "sign_in_link", body)
	}
	assert.Empty(t, h.Rows(httptest.NewRequest(http.MethodGet, "/", nil)), "nothing was stored")
}

// #18668: a picture for the answer to a single agent's question is stored as that agent's file; a question that is not open takes none.
func TestAPictureForASingleAgentsQuestionIsStoredWithThatAgent(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	h := NewAgentAsksHandler(ss, nil)
	h.SetCoralDir(t.TempDir())
	o := owner("0001")
	registerAsker(t, ss, o)
	id, err := ss.CreateAgentAsk(context.Background(), o.SessionID, o.SessionName, "Which logo?", nil, time.Now())
	require.NoError(t, err)
	up := func(id int64, body []byte, agent bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/agent-asks/"+askIDText(id)+"/images", bytes.NewReader(body))
		req.Header.Set("Content-Type", "image/png")
		if agent {
			req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, o))
		} else {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		rec := httptest.NewRecorder()
		rr := chi.NewRouter()
		rr.Post("/api/agent-asks/{id}/images", h.UploadImage)
		rr.ServeHTTP(rec, req)
		return rec
	}
	png := pngBytes(t, 8, 8)
	assert.GreaterOrEqual(t, up(id, png, true).Code, 400, "an agent cannot put a picture in the Operator's reply")
	rec := up(id, png, false)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Regexp(t, `"hex":"[0-9a-f]{64}"`, rec.Body.String())
	assert.GreaterOrEqual(t, up(id, []byte("not a picture"), false).Code, 400, "its own bytes decide")
	assert.Equal(t, http.StatusConflict, up(id+99, png, false).Code, "a question that is not open takes no picture")
}

// #18667: an answer reaches the agent exactly once, even when a second answer arrives while the first is being typed; a delivery that fails leaves the question open to answer again.
func TestAnAnswerToASingleAgentIsTypedOnce(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	h := NewAgentAsksHandler(ss, nil)
	o := owner("0001")
	registerAsker(t, ss, o)
	id, err := ss.CreateAgentAsk(context.Background(), o.SessionID, o.SessionName, "Which?", nil, time.Now())
	require.NoError(t, err)
	answer := func(text string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/agent-asks/"+askIDText(id)+"/answer", strings.NewReader(`{"answer":"`+text+`"}`))
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		rr := chi.NewRouter()
		rr.Post("/api/agent-asks/{id}/answer", h.Answer)
		rr.ServeHTTP(rec, req)
		return rec
	}
	var typed []string
	var second *httptest.ResponseRecorder
	h.deliver = func(_ context.Context, _ ptymanager.SessionTerminal, _, _, _, text, _ string) error {
		typed = append(typed, text)
		if len(typed) == 1 {
			second = answer("again") // typing takes a while: the Operator's second answer arrives meanwhile
		}
		return nil
	}
	assert.Equal(t, http.StatusOK, answer("first").Code)
	require.NotNil(t, second)
	assert.Equal(t, http.StatusConflict, second.Code)
	assert.Len(t, typed, 1, "the agent was told once")

	id2, err := ss.CreateAgentAsk(context.Background(), o.SessionID, o.SessionName, "Which port?", nil, time.Now())
	require.NoError(t, err)
	id = id2
	h.deliver = func(context.Context, ptymanager.SessionTerminal, string, string, string, string, string) error {
		return assert.AnError
	}
	assert.Equal(t, http.StatusBadGateway, answer("x").Code)
	open, err := ss.OpenAgentAsk(context.Background(), id)
	require.NoError(t, err)
	assert.NotNil(t, open, "a failed delivery gives the question back")
}

// #18668: Dismiss closes the question and tells the agent once; Undo gives it back without telling again; a question whose agent has exited drops off the list by itself.
func TestDismissingASingleAgentsQuestionTellsTheAgentAndAnExitedAgentsQuestionDropsOff(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	h := NewAgentAsksHandler(ss, nil)
	o := owner("0001")
	registerAsker(t, ss, o)
	var typed []string
	h.deliver = func(_ context.Context, _ ptymanager.SessionTerminal, _, _, _, text, _ string) error {
		typed = append(typed, text)
		return nil
	}
	id, err := ss.CreateAgentAsk(context.Background(), o.SessionID, o.SessionName, "Approve the logo?", []string{"Approve"}, time.Now())
	require.NoError(t, err)
	dismiss := func(id int64, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/agent-asks/"+askIDText(id)+"/dismiss", strings.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		rr := chi.NewRouter()
		rr.Post("/api/agent-asks/{id}/dismiss", h.Dismiss)
		rr.ServeHTTP(rec, req)
		return rec
	}
	list := func() []operatorAskRow { return h.Rows(httptest.NewRequest(http.MethodGet, "/", nil)) }
	require.Len(t, list(), 1)
	assert.Equal(t, http.StatusOK, dismiss(id, `{}`).Code)
	assert.Empty(t, list(), "dismissed: off the list")
	require.Len(t, typed, 1)
	assert.Contains(t, typed[0], "dismissed your question")
	assert.Equal(t, http.StatusConflict, dismiss(id, `{}`).Code, "not dismissed twice, the agent not told twice")
	assert.Len(t, typed, 1)
	assert.Equal(t, http.StatusOK, dismiss(id, `{"undo":true}`).Code)
	assert.Len(t, list(), 1, "Undo puts it back")
	assert.Len(t, typed, 1, "and tells the agent nothing more")

	require.NoError(t, ss.UnregisterLiveSession(context.Background(), o.SessionID))
	open, err := ss.OpenAgentAsk(context.Background(), id)
	require.NoError(t, err)
	assert.Nil(t, open, "its agent has exited: the question is closed by the exit itself, not by a read of the list (#18714)")
	assert.Empty(t, list(), "and is not listed")
	assert.Equal(t, http.StatusConflict, dismiss(id, `{"undo":true}`).Code, "Undo does not bring back a question closed by an exit")
}

// #18714: Undo brings back only a dismissed question: an answered one stays answered, so the agent is not answered twice.
func TestUndoDoesNotReopenAnAnsweredAgentQuestion(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	h := NewAgentAsksHandler(ss, nil)
	h.deliver = func(context.Context, ptymanager.SessionTerminal, string, string, string, string, string) error {
		return nil
	}
	o := owner("0001")
	registerAsker(t, ss, o)
	id, err := ss.CreateAgentAsk(context.Background(), o.SessionID, o.SessionName, "Which?", nil, time.Now())
	require.NoError(t, err)
	post := func(path, body string, fn http.HandlerFunc) int {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		rr := chi.NewRouter()
		rr.Post("/api/agent-asks/{id}/answer", h.Answer)
		rr.Post("/api/agent-asks/{id}/dismiss", h.Dismiss)
		rr.ServeHTTP(rec, req)
		return rec.Code
	}
	assert.Equal(t, http.StatusOK, post("/api/agent-asks/"+askIDText(id)+"/answer", `{"answer":"A"}`, nil))
	assert.Equal(t, http.StatusConflict, post("/api/agent-asks/"+askIDText(id)+"/dismiss", `{"undo":true}`, nil), "an answered question is not brought back")
	open, err := ss.OpenAgentAsk(context.Background(), id)
	require.NoError(t, err)
	assert.Nil(t, open)
}

// #18553: the Operator answered in the agent's own chat, so the question is closed for them to see (the row's "Answered in chat"): off the list, Undo still works, and the agent is NOT told it was dismissed (it already has the answer, and "dismissed without answering" would be untrue).
func TestAnAgentAskAnsweredInChatIsClosedWithoutTellingTheAgentItWasDismissed(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	h := NewAgentAsksHandler(ss, nil)
	o := owner("0001")
	registerAsker(t, ss, o)
	var typed []string
	h.deliver = func(_ context.Context, _ ptymanager.SessionTerminal, _, _, _, text, _ string) error {
		typed = append(typed, text)
		return nil
	}
	id, err := ss.CreateAgentAsk(context.Background(), o.SessionID, o.SessionName, "Approve the logo?", []string{"Approve"}, time.Now())
	require.NoError(t, err)
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/agent-asks/"+askIDText(id)+"/dismiss", strings.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		rr := chi.NewRouter()
		rr.Post("/api/agent-asks/{id}/dismiss", h.Dismiss)
		rr.ServeHTTP(rec, req)
		return rec
	}
	list := func() []operatorAskRow { return h.Rows(httptest.NewRequest(http.MethodGet, "/", nil)) }
	require.Len(t, list(), 1)
	assert.Equal(t, http.StatusOK, post(`{"answered_in_chat":true}`).Code)
	assert.Empty(t, list(), "closed: off the list")
	assert.Empty(t, typed, "the agent is told nothing: it was answered, not dismissed")
	assert.Equal(t, http.StatusConflict, post(`{"answered_in_chat":true}`).Code, "not closed twice")
	assert.Equal(t, http.StatusOK, post(`{"undo":true}`).Code)
	assert.Len(t, list(), 1, "Undo still puts it back")
}
