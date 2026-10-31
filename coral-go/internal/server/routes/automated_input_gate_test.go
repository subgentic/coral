package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

const (
	gateSID        = "3b1c9d2e-7f40-4a8b-9c1d-2e3f4a5b6c7d"
	permissionMenu = " Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n\n Esc to cancel · Tab to amend\n"
	idleInputBox   = "⏺ Done.\n\n──────────────────────────────────────────\n❯ \n──────────────────────────────────────────\n  ? for shortcuts\n"
)

// screenTerminal is the mock terminal with a screen the test sets (#3431): the
// automated-input gate reads it before typing.
type screenTerminal struct {
	*fgSessionTerminal
	screenMu sync.Mutex
	screen   string
}

func (s *screenTerminal) AgentScreen(context.Context, string, string, string) (string, error) {
	s.screenMu.Lock()
	defer s.screenMu.Unlock()
	return s.screen, nil
}

func (s *screenTerminal) show(screen string) {
	s.screenMu.Lock()
	s.screen = screen
	s.screenMu.Unlock()
}

// The operator's report (#3431): with Claude's permission menu open, a board
// message, a task notification and a board nudge arrive. Nothing is typed (the
// menu stays open, no option is chosen) and nothing is kept (#7727). Once the
// user answers the menu, the next ones are typed at once, in order.
func TestAutomatedMessagesAreNotTypedWhileAPermissionMenuIsOpen(t *testing.T) {
	t.Parallel() // no shared state: these ran one after another (#5622)
	_, handler, mock, ss := setupSessionsTestServer(t)
	term := &screenTerminal{fgSessionTerminal: newFGTerminal(mock), screen: permissionMenu}
	handler.terminal = term
	ctx := context.Background()
	name := naming.SessionName("claude", gateSID)
	board := noticeBoard(t, term, name)
	mock.addSession(name, "/tmp/test")
	term.setFG(name, "node")
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: gateSID, AgentType: "claude", AgentName: "repo", WorkingDir: "/tmp/test"}))

	require.NoError(t, board.sendAutomated(ctx, "team", name, "[Lead] please review the patch"))
	prompt, errMsg := handler.notifyTaskCreated(ctx, name, gateSID, &store.AgentTask{ID: 7, Title: "Fix the flake"})
	require.Empty(t, errMsg)
	require.NotEmpty(t, prompt)
	require.NoError(t, board.sendAutomated(ctx, "team", name, "You have 2 unread messages on the message board."))

	time.Sleep(300 * time.Millisecond)
	assert.Empty(t, term.sentTo(name), "nothing typed while the permission menu is open")

	term.show(idleInputBox) // the user answered the menu
	time.Sleep(300 * time.Millisecond)
	assert.Empty(t, term.sentTo(name), "what was skipped is not kept and typed later")
	require.NoError(t, board.sendAutomated(ctx, "team", name, "[Lead] please review the patch"))
	require.NoError(t, board.sendAutomated(ctx, "team", name, "You have 2 unread messages on the message board."))
	assert.Equal(t, []string{"[Lead] please review the patch", "You have 2 unread messages on the message board."}, term.sentTo(name), "typed at once, in order")
}

// /send from anything but a person (here: no dashboard, Hub or signed-CLI
// classification) is automation: held while a prompt is open, answering 202.
// The dashboard's own /send is a person typing and is sent at once.
func TestSendFromAScriptIsSkippedAtAPromptButTheDashboardTypes(t *testing.T) {
	t.Parallel() // no shared state: these ran one after another (#5622)
	_, handler, mock, ss := setupSessionsTestServer(t)
	term := &screenTerminal{fgSessionTerminal: newFGTerminal(mock), screen: permissionMenu}
	handler.terminal = term
	name := naming.SessionName("claude", gateSID)
	mock.addSession(name, "/tmp/test")
	term.setFG(name, "node")
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: gateSID, AgentType: "claude", AgentName: "repo", WorkingDir: "/tmp/test"}))

	r := chi.NewRouter()
	r.Post("/api/sessions/live/{name}/send", handler.Send)
	post := func(caller string, cmd string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/send",
			bytes.NewBufferString(`{"command": "`+cmd+`", "agent_type": "claude", "session_id": "`+gateSID+`"}`))
		if caller != "" {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, caller))
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	rec := post("", "1")
	assert.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"skipped":true`)
	rec = post(callerAPIKey, "yes")
	assert.Equal(t, http.StatusAccepted, rec.Code, "an API-key caller is automation")
	assert.Empty(t, term.sentTo(name), "a script can't answer the menu")

	rec = post(callerDashCookie, "2")
	assert.Equal(t, http.StatusOK, rec.Code, "the dashboard is a person")
	assert.Equal(t, []string{"2"}, term.sentTo(name))

	term.show(idleInputBox)
	time.Sleep(300 * time.Millisecond)
	assert.Equal(t, []string{"2"}, term.sentTo(name), "what a script sent at the prompt is not kept")
	rec = post(callerAPIKey, "yes")
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, []string{"2", "yes"}, term.sentTo(name))
}

// Who counts as a person for /send and /keys (#3431), through the real identity
// observer: this computer's browser (same-origin fetch) and the dashboard
// cookie do. The same browser headers on a request that carries an agent's
// session token or an agent tool's User-Agent do NOT: an agent can't pass its
// input off as the dashboard's by adding Origin and Sec-Fetch-Site.
func TestHumanInputCallerCantBeClaimedByAnAgent(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	token, err := db.MintSessionToken(context.Background(), "sid-agent", "claude-agent")
	require.NoError(t, err)
	cookie := false
	o := NewIdentityObserver(db, nil, func(*http.Request) bool { return cookie })
	var human bool
	h := o.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { human = humanInputCaller(r) }))
	ask := func(hdr map[string]string) bool {
		r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8450/api/sessions/live/x/send", nil)
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		human = false
		h.ServeHTTP(httptest.NewRecorder(), r)
		return human
	}
	browser := map[string]string{"Origin": "http://127.0.0.1:8450", "Sec-Fetch-Site": "same-origin"}
	assert.True(t, ask(browser), "this computer's browser")
	cookie = true
	assert.True(t, ask(map[string]string{}), "the signed-in dashboard")
	cookie = false

	withToken := map[string]string{store.SessionTokenHeader: token}
	for k, v := range browser {
		withToken[k] = v
	}
	assert.False(t, ask(withToken), "an agent's token with browser headers is still the agent")
	agentTool := map[string]string{"User-Agent": "coral-agent/1.4"}
	for k, v := range browser {
		agentTool[k] = v
	}
	assert.False(t, ask(agentTool), "an agent tool with browser headers is still automation")
	assert.False(t, ask(map[string]string{"X-API-Key": "k"}), "an API key")
	// Forged proofs (Backend's #3431 review, required 1): only the connector's
	// own stamp makes a Coral Hub request, and only a checked signature the
	// signed CLI.
	assert.False(t, ask(map[string]string{tunnel.ViaHeader: "1"}), "a forged Coral Hub header")
	assert.False(t, ask(map[string]string{cliauth.CLIAuthHeader: "x"}), "a forged command-line signature")
	assert.False(t, ask(map[string]string{}), "a bare local caller")
}

// #11352, Security's #136728: whatever closes a request in the events (a start, a Dismiss), the automated-input gate reads the terminal itself before it types: a screen that still shows a
// permission dialog gets nothing, even when the state says the request is closed.
func TestAutomatedMessagesAreNotTypedAtAPermissionDialogEvenWhenTheStateSaysClosed(t *testing.T) {
	t.Parallel()
	_, handler, mock, ss := setupSessionsTestServer(t)
	term := &screenTerminal{fgSessionTerminal: newFGTerminal(mock), screen: permissionMenu}
	handler.terminal = term
	ctx := context.Background()
	name := naming.SessionName("claude", gateSID)
	board := noticeBoard(t, term, name)
	mock.addSession(name, "/tmp/test")
	term.setFG(name, "node")
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: gateSID, AgentType: "claude", AgentName: "repo", WorkingDir: "/tmp/test"}))
	sid := gateSID
	for _, ev := range []*store.AgentEvent{
		{AgentName: "repo", SessionID: &sid, EventType: "prompt_submit", Summary: "User submitted prompt"},
		{AgentName: "repo", SessionID: &sid, EventType: "permission_request", Summary: "Waiting for the user: permission (Bash)", DetailJSON: ptrString(`{"kind":"permission","tool_name":"Bash"}`)},
		{AgentName: "repo", SessionID: &sid, EventType: "request_resolved", Summary: "The Operator dismissed the wait", DetailJSON: ptrString(`{"dismissed":true}`)},
	} {
		_, err := handler.ts.InsertAgentEvent(ctx, ev)
		require.NoError(t, err)
	}
	require.False(t, handler.deriveSingleSessionState(ctx, gateSID, 0).NeedsInput, "the state says the request is closed")

	require.NoError(t, board.sendAutomated(ctx, "team", name, "You have 2 unread messages on the message board."))
	time.Sleep(300 * time.Millisecond)
	assert.Empty(t, term.sentTo(name), "the screen still shows the permission dialog: nothing is typed into it")
}
