package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
)

// #11417: a question an agent asked the Operator (post --ask, or wait --operator) is listed for their Needs you; one asked of someone else is not; the Operator's reply closes it; only the person reads it.

func operatorAsksRig(t *testing.T) (*BoardHandler, *board.Store) {
	t.Helper()
	bs, err := boardtest.Open(t.TempDir() + "/board.db")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	return h, bs
}

func readOperatorAsks(t *testing.T, h *BoardHandler, mod func(*http.Request) *http.Request) (int, []map[string]any, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/operator-asks", nil)
	if mod != nil {
		req = mod(req)
	}
	w := httptest.NewRecorder()
	h.OperatorAsks(w, req)
	var rows []map[string]any
	var body map[string]any
	if w.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &rows))
	} else {
		_ = json.Unmarshal(w.Body.Bytes(), &body)
	}
	return w.Code, rows, body
}

// asPerson is the dashboard's own request.
func asPerson(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerDashCookie))
}

func TestOperatorAsksListsWhatAgentsAskedTheOperatorAndTheirReplyClosesIt(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	for _, who := range []string{"Lead", "Dev"} {
		_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	_, err := bs.Subscribe(ctx, "team", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	ask := func(from, text string) *board.Message {
		q, err := bs.PostMessage(ctx, "team", from, text, nil)
		require.NoError(t, err)
		if to, err := bs.AskTargets(ctx, "team", from, q.Content); err == nil {
			require.NoError(t, bs.RecordAsk(ctx, "team", q, to))
		}
		return q
	}
	toOp := ask("Lead", "@Operator which of the two designs do we ship? \u202eevil")
	ask("Lead", "@Dev which parser do we keep?") // another member's: never in the Operator's list

	code, rows, _ := readOperatorAsks(t, h, asPerson)
	require.Equal(t, http.StatusOK, code)
	require.Len(t, rows, 1, "only the question to the Operator")
	assert.Equal(t, "ask", rows[0]["kind"])
	assert.Equal(t, "team", rows[0]["board"])
	assert.Equal(t, "Lead", rows[0]["asker"])
	assert.EqualValues(t, toOp.ID, rows[0]["id"])
	assert.Contains(t, rows[0]["text"], "which of the two designs")
	assert.NotContains(t, rows[0]["text"], "\u202e", "the text is cleaned")

	// an operator wait is in the same list
	_, err = bs.RegisterWait(ctx, "team", "Dev", "claude-x", board.WaitOperator, "", "may I delete the old table?", time.Hour)
	require.NoError(t, err)
	_, rows, _ = readOperatorAsks(t, h, asPerson)
	require.Len(t, rows, 2)
	assert.Equal(t, "wait", rows[1]["kind"])
	assert.Equal(t, "Dev", rows[1]["asker"])
	assert.Equal(t, "may I delete the old table?", rows[1]["text"])

	// the Operator's reply closes both: a reply_to the question answers it, and any post of theirs ends the wait
	reply, err := bs.PostMessage(ctx, "team", "Operator", "@Lead the second one", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordReply(ctx, "team", reply.ID, toOp.ID))
	_, err = bs.PostMessage(ctx, "team", "Operator", "@Dev yes, delete it", nil)
	require.NoError(t, err)
	_, err = bs.ResolveMatchingMessageWaits(ctx, "team", "Operator", "@Dev yes, delete it") // what the post route does after a post
	require.NoError(t, err)
	_, rows, _ = readOperatorAsks(t, h, asPerson)
	assert.Empty(t, rows, "answered: the list no longer has them")
}

// A question to the Operator shows even when they have not posted on that board yet (they are not a member of it until their first post).
func TestOperatorAsksShowsAQuestionOnABoardTheOperatorHasNotPostedOn(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	q, err := bs.PostMessage(ctx, "other", "Lead", "@Operator may I proceed?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "other", q, []string{"Operator"}))
	_, rows, _ := readOperatorAsks(t, h, asPerson)
	require.Len(t, rows, 1)
	assert.Equal(t, "other", rows[0]["board"])
}

func TestOperatorAsksCutsAVeryLongQuestionAndSaysSo(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator "+strings.Repeat("long ", 2000), nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	_, rows, _ := readOperatorAsks(t, h, asPerson)
	require.Len(t, rows, 1)
	assert.Equal(t, true, rows[0]["cut"])
	assert.LessOrEqual(t, len(rows[0]["text"].(string)), operatorAskTextMax)
}

func TestOperatorAsksIsTheOperatorsAloneNotAnAgentsNorAScripts(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator is this fine?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	for name, mod := range map[string]func(*http.Request) *http.Request{
		"an agent's token":          func(r *http.Request) *http.Request { r.Header.Set(store.SessionTokenHeader, "tok"); return r },
		"a caller with no identity": nil,
	} {
		code, rows, body := readOperatorAsks(t, h, mod)
		assert.Equal(t, http.StatusForbidden, code, name)
		assert.Equal(t, "operator_only", body["code"], name)
		assert.Empty(t, rows, name)
	}
}

// #11417: a question the Operator answered elsewhere (chat, an artifact comment) is closed by hand, by the asker, the Operator or the orchestrator, with a note; nobody else; it leaves every list.
func TestAnAskAnsweredElsewhereIsClosedByTheAskerTheOperatorOrTheOrchestratorOnly(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	for _, who := range []struct{ id, title string }{{"Lead", "Lead Developer"}, {"Dev", "Developer"}, {"Orch", "Orchestrator"}, {"Other", "QA"}} {
		_, err := bs.Subscribe(ctx, "team", who.id, who.title, "", nil, "all")
		require.NoError(t, err)
	}
	ask := func() int64 {
		q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator may I proceed?", nil)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
		return q.ID
	}
	closeAsk := func(id int64, who, note string) (int, map[string]any) {
		body, _ := json.Marshal(map[string]any{"subscriber_id": who, "note": note})
		req := httptest.NewRequest(http.MethodPost, "/api/board/team/asks/x/close", strings.NewReader(string(body)))
		if who == "Operator" {
			req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
		} else {
			req = withActor(req, Actor{Kind: ActorToken, Name: who, Session: "claude-" + who}) // the verified caller: what the body claims is ignored
		}
		rc := chi.NewRouteContext()
		rc.URLParams.Add("project", "team")
		rc.URLParams.Add("messageID", fmt.Sprint(id))
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
		w := httptest.NewRecorder()
		h.CloseAsk(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	open := func() int {
		_, rows, _ := readOperatorAsks(t, h, asPerson)
		return len(rows)
	}

	id := ask()
	require.Equal(t, 1, open())
	code, out := closeAsk(id, "Other", "answered in chat")
	assert.Equal(t, http.StatusForbidden, code, "another member may not close it")
	assert.Equal(t, "not_allowed", out["code"])
	assert.Equal(t, 1, open())
	code, _ = closeAsk(id, "Lead", "  ")
	assert.Equal(t, http.StatusBadRequest, code, "a note is required: say where it was answered")
	code, _ = closeAsk(99999, "Lead", "answered in chat")
	assert.Equal(t, http.StatusNotFound, code)
	code, out = closeAsk(id, "Lead", "the operator answered in the chat")
	assert.Equal(t, http.StatusOK, code, "the asker")
	assert.Equal(t, "Lead", out["closed_by"])
	assert.Equal(t, 0, open(), "closed: it leaves the Operator's list")
	asks, err := bs.OpenAsks(ctx, "team", time.Now())
	require.NoError(t, err)
	assert.Empty(t, asks, "and the health check's open asks")

	for _, who := range []string{"Operator", "Orch"} {
		id := ask()
		code, _ = closeAsk(id, who, "answered in an artifact comment")
		assert.Equal(t, http.StatusOK, code, who)
		assert.Equal(t, 0, open(), who)
	}
	// the ask says it was closed, by whom and why
	m, err := bs.GetMessageByID(ctx, "team", id)
	require.NoError(t, err)
	require.NotNil(t, m.Ask)
	assert.True(t, m.Ask.Closed)
	assert.Equal(t, "Lead", m.Ask.ClosedBy)
	assert.Equal(t, "the operator answered in the chat", m.Ask.ClosedNote)
	assert.True(t, m.Ask.Answered)
}

// Security's SHOULD on #11417: the caller is the verified actor, whatever the body claims. A token that names itself the Operator or the asker is still who its token says, and a caller nothing backs is refused.
func TestCloseAskTrustsTheVerifiedActorAndNeverTheClaim(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	for _, who := range []struct{ id, title string }{{"Lead", "Lead Developer"}, {"Other", "QA"}} {
		_, err := bs.Subscribe(ctx, "team", who.id, who.title, "", nil, "all")
		require.NoError(t, err)
	}
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator may I proceed?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	call := func(actor *Actor, claim string) int {
		body, _ := json.Marshal(map[string]any{"subscriber_id": claim, "note": "answered in chat"})
		req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(string(body)))
		if actor != nil {
			req = withActor(req, *actor)
		}
		rc := chi.NewRouteContext()
		rc.URLParams.Add("project", "team")
		rc.URLParams.Add("messageID", fmt.Sprint(q.ID))
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
		w := httptest.NewRecorder()
		h.CloseAsk(w, req)
		return w.Code
	}
	open := func() int { _, rows, _ := readOperatorAsks(t, h, asPerson); return len(rows) }
	assert.Equal(t, http.StatusForbidden, call(&Actor{Kind: ActorToken, Name: "Other", Session: "claude-other"}, "Operator"), "a token that claims to be the Operator is the member its token says")
	assert.Equal(t, http.StatusForbidden, call(&Actor{Kind: ActorToken, Name: "Other", Session: "claude-other"}, "Lead"), "and one that claims to be the asker")
	assert.Equal(t, http.StatusForbidden, call(nil, "Operator"), "a request no identity backs is refused, whatever it names")
	assert.Equal(t, http.StatusForbidden, call(&Actor{Kind: ActorClaimed}, "Lead"), "a claimed actor too")
	assert.Equal(t, 1, open(), "nothing was closed")
	assert.Equal(t, http.StatusOK, call(&Actor{Kind: ActorToken, Name: "Lead", Session: "claude-lead"}, "Other"), "the asker's own token closes it, whatever it claims")
	assert.Equal(t, 0, open())
}
