package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #8558 (Goal #58): a team's Orchestrator may look at what waits for the agents of its OWN board, and type their nudge now; everyone else keeps the 403. The check is the server's, by the caller's session
// token (its orchestrator role on its board) and the target's board; the route is not on the Hub's tunnel table.

type waitingTeamEnv struct {
	t       *testing.T
	srv     *httptest.Server
	mock    *mockSessionTerminal
	handler *SessionsHandler
	ss      *store.SessionStore
	term    *screenTerminal
	tokens  map[string]string // by member
	sids    map[string]string
	names   map[string]string
	boardOf map[string]string
}

func newWaitingTeamEnv(t *testing.T) *waitingTeamEnv {
	t.Helper()
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	cfg := &config.Config{LogDir: t.TempDir()}
	cfg.UseCoralDir(t.TempDir())
	mock := newMockTerminal()
	h := NewSessionsHandler(db, cfg, nil, mock, bs)
	ss := store.NewSessionStore(db)
	stubCLIPaths(t, ss)

	e := &waitingTeamEnv{t: t, mock: mock, handler: h, ss: ss, tokens: map[string]string{}, sids: map[string]string{}, names: map[string]string{}, boardOf: map[string]string{}}
	members := []struct{ who, title, board, sid string }{
		{"Lead", "Orchestrator", "alpha", "aaaaaaaa-0000-4000-8000-000000000001"},
		{"Worker", "Backend", "alpha", "aaaaaaaa-0000-4000-8000-000000000002"},
		{"Dev", "Developer", "alpha", "aaaaaaaa-0000-4000-8000-000000000003"},
		{"OtherLead", "Orchestrator", "beta", "bbbbbbbb-0000-4000-8000-000000000001"},
		{"OtherWorker", "Backend", "beta", "bbbbbbbb-0000-4000-8000-000000000002"},
	}
	term := &screenTerminal{fgSessionTerminal: newFGTerminal(mock), screen: idleInputBox}
	h.terminal = term
	e.term = term
	for _, m := range members {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: m.sid, AgentName: m.who, AgentType: "claude", WorkingDir: t.TempDir()}))
		name := naming.SessionName("claude", m.sid)
		mock.addSession(name, "/tmp/"+m.who)
		term.setFG(name, "node")
		_, err := bs.Subscribe(ctx, m.board, m.who, m.title, name, nil, "mentions")
		require.NoError(t, err)
		tok, err := db.MintSessionToken(ctx, m.sid, name)
		require.NoError(t, err)
		e.tokens[m.who], e.sids[m.who], e.names[m.who], e.boardOf[m.who] = tok, m.sid, name, m.board
	}
	// something waits for the two workers and the developer
	for _, p := range []struct{ board, text string }{{"alpha", "@Worker please look"}, {"alpha", "@Dev and you"}, {"beta", "@OtherWorker over to you"}} {
		poster := map[string]string{"alpha": "Lead", "beta": "OtherLead"}[p.board]
		_, err := bs.PostMessage(ctx, p.board, poster, p.text, nil)
		require.NoError(t, err)
	}

	o := NewIdentityObserver(db, bs, func(*http.Request) bool { return false })
	r := chi.NewRouter()
	r.Use(o.Middleware)
	r.Get("/api/sessions/live/{name}/waiting", h.ListWaiting)
	r.Post("/api/sessions/live/{name}/waiting/send", h.SendWaitingNow)
	e.srv = httptest.NewServer(r)
	t.Cleanup(e.srv.Close)
	return e
}

// call is the request an agent's tool makes: the caller's token, the target by its exact session.
func (e *waitingTeamEnv) call(caller, target string, send bool) (int, map[string]any) {
	e.t.Helper()
	url := e.srv.URL + "/api/sessions/live/" + e.names[target] + "/waiting"
	var req *http.Request
	if send {
		req, _ = http.NewRequest(http.MethodPost, url+"/send", strings.NewReader(`{"agent_type":"claude","session_id":"`+e.sids[target]+`"}`))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req, _ = http.NewRequest(http.MethodGet, url+"?agent_type=claude&session_id="+e.sids[target], nil)
	}
	req.Header.Set(store.SessionTokenHeader, e.tokens[caller])
	resp, err := http.DefaultClient.Do(req)
	require.NoError(e.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestAnOrchestratorLooksAtWhatWaitsForItsOwnMembers(t *testing.T) {
	e := newWaitingTeamEnv(t)
	for _, target := range []string{"Worker", "Dev", "Lead"} { // the member of its board, another, and itself
		code, out := e.call("Lead", target, false)
		require.Equal(t, http.StatusOK, code, "Lead looks at %s: %v", target, out)
		assert.Equal(t, "alpha", out["board"], target)
	}
	code, out := e.call("Lead", "Worker", false)
	require.Equal(t, http.StatusOK, code)
	assert.EqualValues(t, 1, out["unread"], "the nudge's count is the member's own")
}

func TestAnOrchestratorTypesTheNudgeNowForItsOwnMember(t *testing.T) {
	e := newWaitingTeamEnv(t)
	code, out := e.call("Lead", "Worker", true)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["sent"])
	e.mock.mu.Lock()
	defer e.mock.mu.Unlock()
	assert.NotEmpty(t, e.mock.sent[e.names["Worker"]], "the nudge was typed into the member's terminal")
	assert.Empty(t, e.mock.sent[e.names["Dev"]], "and nowhere else")
}

func TestAnOrchestratorIsRefusedForAnotherTeamsMember(t *testing.T) {
	e := newWaitingTeamEnv(t)
	for _, send := range []bool{false, true} {
		code, out := e.call("Lead", "OtherWorker", send)
		assert.Equal(t, http.StatusForbidden, code, "send=%v: %v", send, out)
	}
	e.mock.mu.Lock()
	defer e.mock.mu.Unlock()
	assert.Empty(t, e.mock.sent[e.names["OtherWorker"]], "nothing was typed into another team's agent")
}

func TestAMemberWhoIsNotAnOrchestratorIsRefused(t *testing.T) {
	e := newWaitingTeamEnv(t)
	for _, caller := range []string{"Worker", "Dev"} {
		for _, target := range []string{"Dev", "Worker", caller} {
			for _, send := range []bool{false, true} {
				code, out := e.call(caller, target, send)
				assert.Equal(t, http.StatusForbidden, code, "%s -> %s send=%v: %v", caller, target, send, out)
				assert.Equal(t, "forbidden_for_agent", out["code"], "%s -> %s send=%v", caller, target, send)
			}
		}
	}
	e.mock.mu.Lock()
	defer e.mock.mu.Unlock()
	assert.Empty(t, e.mock.sent[e.names["Worker"]])
	assert.Empty(t, e.mock.sent[e.names["Dev"]])
}

// The same checks as the Operator's send: a prompt that is open or a draft in the input box still stops it.
func TestAnOrchestratorsSendStillStopsAtAnOpenPromptOrADraft(t *testing.T) {
	e := newWaitingTeamEnv(t)
	e.term.show(permissionMenu)
	code, out := e.call("Lead", "Worker", true)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, false, out["sent"], "an open prompt stops the send")
	assert.Equal(t, true, out["prompt_open"])
	e.mock.mu.Lock()
	defer e.mock.mu.Unlock()
	assert.Empty(t, e.mock.sent[e.names["Worker"]])
}

// The handler checks the caller itself, whatever stands in front of it: an agent's session that is not an orchestrator of its board is refused with the identity layer out of the way.
func TestTheWaitingHandlersRefuseANonOrchestratorAgentOnTheirOwn(t *testing.T) {
	e := newWaitingTeamEnv(t)
	ctx := context.Background()
	h := e.handler
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.Header.Get("X-Test-Nil") != "" { // an agent's request whose verified session is nil
				req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, (*store.SessionTokenOwner)(nil)))
			}
			if who := req.Header.Get("X-Test-Who"); who != "" {
				req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: e.sids[who], SessionName: e.names[who]}))
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Get("/api/sessions/live/{name}/waiting", h.ListWaiting)
	r.Post("/api/sessions/live/{name}/waiting/send", h.SendWaitingNow)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	get := func(who, target string) int {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/sessions/live/"+e.names[target]+"/waiting?agent_type=claude&session_id="+e.sids[target], nil)
		if who != "" {
			req.Header.Set("X-Test-Who", who)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp.StatusCode
	}
	assert.Equal(t, http.StatusForbidden, get("Worker", "Dev"), "a member that is not an orchestrator")
	assert.Equal(t, http.StatusForbidden, get("Lead", "OtherWorker"), "an orchestrator, another team's member")
	assert.Equal(t, http.StatusOK, get("Lead", "Worker"), "an orchestrator, its own member")
	assert.Equal(t, http.StatusOK, get("", "Worker"), "no agent's token (the Operator's dashboard and command line) is not asked")

	// a caller and a target that are live sessions on no board at all: a refusal, not the Recoverer's 500 (#8582)
	for i, who := range []string{"GhostA", "GhostB"} {
		sid := "cccccccc-0000-4000-8000-00000000000" + string(rune('1'+i))
		require.NoError(t, e.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: who, AgentType: "claude", WorkingDir: t.TempDir()}))
		e.sids[who], e.names[who] = sid, naming.SessionName("claude", sid)
		e.mock.addSession(e.names[who], "/tmp/"+who)
	}
	assert.Equal(t, http.StatusForbidden, get("GhostA", "GhostB"), "an unsubscribed caller, an unsubscribed target (look)")
	post := func(who, target string) int {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/api/sessions/live/"+e.names[target]+"/waiting/send", strings.NewReader(`{"agent_type":"claude","session_id":"`+e.sids[target]+`"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Test-Who", who)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp.StatusCode
	}
	assert.Equal(t, http.StatusForbidden, post("GhostA", "GhostB"), "an unsubscribed caller, an unsubscribed target (send)")
	assert.Equal(t, http.StatusForbidden, post("Lead", "GhostB"), "an orchestrator, a target on no board")
	assert.Equal(t, http.StatusForbidden, post("GhostA", "Worker"), "an unsubscribed caller, a member")
	// a nil verified session: a refusal, not a panic
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		url := srv.URL + "/api/sessions/live/" + e.names["Worker"] + "/waiting"
		if method == http.MethodPost {
			url += "/send"
		}
		req, _ := http.NewRequestWithContext(ctx, method, url+"?agent_type=claude&session_id="+e.sids["Worker"], strings.NewReader(`{"agent_type":"claude","session_id":"`+e.sids["Worker"]+`"}`))
		req.Header.Set("X-Test-Nil", "1")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err, method+": the handler panicked")
		resp.Body.Close()
		assert.Equal(t, http.StatusForbidden, resp.StatusCode, method)
	}
}

// Every route an Orchestrator may use is an operator-only route (so every other agent is refused by the same table), and is not served through the Hub's tunnel.
func TestTheOrchestratorOwnBoardRoutesAreOperatorOnlyRoutes(t *testing.T) {
	for k := range orchestratorOwnBoardRoutes {
		assert.NotEmpty(t, operatorOnlyRoutes[k], "%s is in operatorOnlyRoutes", k)
	}
}
