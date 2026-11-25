package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #21256 (coral-hub #273334): a Codex agent sat 22 minutes at its own permission prompt (`git rebase origin/main`). Coral knew (the hook's permission_request, waiting_for_input), but the Needs you feed a
// Hub reads gave the item no Yes and No, so the person on a phone could not answer it there. Now a hooked permission wait carries the prompt's ONE-TIME choices; a press from Needs you is checked again on
// the Coral (only the person, only a one-time choice, the label the button showed); a prompt only the screen saw is a Needs you item too, with no lasting grant offered.

// codexExecScreen is the captured Codex exec approval menu: 1 Yes, proceed; 2 a lasting "don't ask again"; 3 No.
func codexExecScreen(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../../ptymanager/testdata/screens/codex/legacy/exec.txt")
	require.NoError(t, err)
	return string(b)
}

func TestPermissionOptionsOfferOnlyTheOneTimeYesAndNo(t *testing.T) {
	codex := []NeedsYouOption{{N: 1, Label: "Yes, proceed (y)"}, {N: 2, Label: "Yes, and don't ask again for commands that start with `git rebase` (p)"}, {N: 3, Label: "No, and tell Codex what to do differently (esc)"}}
	assert.Equal(t, []NeedsYouOption{codex[0], codex[2]}, permissionOptions(codex), "the lasting grant is dropped; Yes and No keep their own numbers")

	claude := []NeedsYouOption{{N: 1, Label: "Yes"}, {N: 2, Label: "Yes, allow all edits during this session (shift+tab)"}, {N: 3, Label: "No"}}
	assert.Equal(t, []NeedsYouOption{claude[0], claude[2]}, permissionOptions(claude))

	assert.Nil(t, permissionOptions([]NeedsYouOption{{N: 1, Label: "Yes, and don't ask again"}, {N: 2, Label: "No"}}), "no one-time Yes: nothing offered, not a lone No")
	assert.Nil(t, permissionOptions([]NeedsYouOption{{N: 1, Label: "Yes"}, {N: 2, Label: "Always allow"}}), "no No: nothing offered")
	assert.Nil(t, permissionOptions([]NeedsYouOption{{N: 1, Label: "Yes (always)"}, {N: 2, Label: "No"}}), "a bracket that is not a key stays in the label, and the whole label must be one-time")

	for _, l := range []string{"Yes", "Yes, proceed (y)", "Allow once", "Approve.", "No, and tell Codex what to do differently (esc)", "Deny", "Reject, cancel"} {
		assert.True(t, oneTimeChoice(l), l)
	}
	for _, l := range []string{"Yes, and don't ask again", "Yes, allow all edits during this session", "Always allow", "Yes, for this project", "Trust all and continue", "Yes forever"} {
		assert.False(t, oneTimeChoice(l), l)
	}
}

// permissionHarness is a Codex agent whose hook said it waits on a permission prompt, with Codex's exec menu on its screen, served through a router that sets who is calling.
type permissionHarness struct {
	h        *SessionsHandler
	terminal *mockSessionTerminal
	url      string
	sid      string
	name     string
}

func newPermissionHarness(t *testing.T, caller *string) *permissionHarness {
	t.Helper()
	_, h, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-0000002125a6"
	name := "codex-" + sid
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "codex", AgentName: name, WorkingDir: "/tmp/test"}))
	terminal.addSession(name, "/tmp/test")
	terminal.outputs[name] = codexExecScreen(t)
	detail := `{"call_ids":["exec-1"],"kind":"permission","tool_name":"Bash","wants":"Wants to run: git rebase origin/main"}`
	_, err := h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: name, SessionID: ptr.NonEmpty(sid), EventType: "permission_request", ToolName: ptr.NonEmpty("Bash"), Summary: "Waiting for the user: permission (Bash)", DetailJSON: &detail})
	require.NoError(t, err)
	promptTextDelay = 0
	fastPromptChecks(t)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if *caller != "" {
				req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, *caller))
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Post("/api/sessions/live/{name}/answer-prompt", h.AnswerPrompt)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &permissionHarness{h: h, terminal: terminal, url: srv.URL, sid: sid, name: name}
}

func (p *permissionHarness) keys() []string {
	p.terminal.mu.Lock()
	defer p.terminal.mu.Unlock()
	return append([]string(nil), p.terminal.raw[p.name]...)
}

func (p *permissionHarness) press(t *testing.T, n int, label, from string) (int, string) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"n": n, "label": label, "session_id": p.sid, "agent_type": "codex", "from": from})
	resp, err := http.Post(p.url+"/api/sessions/live/"+p.name+"/answer-prompt", "application/json", bytes.NewReader(b))
	require.NoError(t, err)
	defer resp.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	code, _ := body["code"].(string)
	return resp.StatusCode, code
}

func TestAHookedPermissionWaitIsANeedsYouItemWithItsOneTimeYesAndNo(t *testing.T) {
	caller := callerDashCookie
	p := newPermissionHarness(t, &caller)
	ctx := context.Background()
	t0 := time.Now()
	p.h.dialogPass(ctx, t0)
	p.h.dialogPass(ctx, t0.Add(15*time.Second))

	items, err := p.h.NeedsYouAgents(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
	require.NoError(t, err)
	require.Len(t, items, 1, "the agent at its permission prompt waits on the person")
	it := items[0]
	assert.Equal(t, "agent:"+p.sid, it.ID)
	assert.Equal(t, p.name, it.From, "it names the agent")
	assert.Contains(t, it.Line, "git rebase origin/main", "and the exact command")
	assert.True(t, it.Permission)
	assert.False(t, it.Dialog, "its hooks reported it: a wait, not a screen-only dialog")
	require.Len(t, it.Options, 2, "Yes and No, the lasting grant dropped: %v", it.Options)
	assert.Equal(t, 1, it.Options[0].N)
	assert.True(t, strings.HasPrefix(it.Options[0].Label, "Yes, proceed"))
	assert.Equal(t, 3, it.Options[1].N)
	assert.True(t, strings.HasPrefix(it.Options[1].Label, "No"))
	for _, o := range it.Options {
		assert.NotContains(t, strings.ToLower(o.Label), "ask again")
	}
}

func TestAPressFromNeedsYouIsCheckedOnTheCoral(t *testing.T) {
	caller := ""
	p := newPermissionHarness(t, &caller)
	yes := "Yes, proceed (y)"

	code, why := p.press(t, 1, yes, "needs_you")
	assert.Equal(t, http.StatusForbidden, code, "a caller that is not the person (no dashboard, no stamped owner) is refused")
	assert.Equal(t, "not_the_person", why)
	caller = callerHub // the Hub's own automation: no genuine owner stamp
	code, _ = p.press(t, 1, yes, "")
	assert.Equal(t, http.StatusForbidden, code, "Hub automation without the owner's stamp never answers a permission prompt, from Needs you or not")
	assert.Empty(t, p.keys(), "nothing is typed on a refusal")

	caller = callerDashCookie
	code, _ = p.press(t, 2, "Yes, and don't ask again for commands that start with `touch", "needs_you")
	assert.Equal(t, http.StatusConflict, code, "a label mismatch is refused")
	assert.Empty(t, p.keys(), "a label that is not the one on screen types nothing")

	screen, ok := parsePromptScreenFor("codex", codexExecScreen(t))
	require.True(t, ok)
	code, why = p.press(t, 2, screen.Options[1].Label, "needs_you")
	assert.Equal(t, http.StatusConflict, code, "the lasting grant's own digit, with its exact label, is refused from Needs you")
	assert.Equal(t, "lasting_choice", why)
	assert.Empty(t, p.keys())

	// The menu changes between the read and the press: digit 1 is now a lasting grant. The button's label no longer matches, and nothing is typed.
	p.terminal.mu.Lock()
	p.terminal.outputs[p.name] = strings.Replace(codexExecScreen(t), "1. Yes, proceed (y)", "1. Yes, and don't ask again (a)", 1)
	p.terminal.mu.Unlock()
	code, _ = p.press(t, 1, yes, "needs_you")
	assert.Equal(t, http.StatusConflict, code)
	assert.Empty(t, p.keys(), "a menu that changed under the button types nothing")

	p.terminal.mu.Lock()
	p.terminal.outputs[p.name] = codexExecScreen(t)
	p.terminal.onRaw = func(string) { p.terminal.outputs[p.name] = screenIdleList }
	p.terminal.mu.Unlock()
	code, _ = p.press(t, 1, yes, "needs_you")
	assert.Equal(t, http.StatusOK, code, "the person's one-time Yes is answered")
	assert.Equal(t, []string{"1"}, p.keys())
}

func TestAnAgentTokenCannotAnswerAPromptFromNeedsYou(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	defer db.Close()
	token, err := db.MintSessionToken(context.Background(), "sid-dev", "codex-dev")
	require.NoError(t, err)
	o := NewIdentityObserver(db, nil, func(*http.Request) bool { return false })
	r := chi.NewRouter()
	r.Use(o.Middleware)
	reached := false
	r.Post("/api/sessions/live/{name}/answer-prompt", func(http.ResponseWriter, *http.Request) { reached = true })
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/codex-dev/answer-prompt", strings.NewReader(`{"n":1,"label":"Yes","session_id":"sid-dev","agent_type":"codex","from":"needs_you"}`))
	req.Header.Set(store.SessionTokenHeader, token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusForbidden, rec.Code, "an agent's token is refused, its own session included")
	assert.False(t, reached)

	tokened := httptest.NewRequest(http.MethodPost, "/", nil)
	tokened.Header.Set(store.SessionTokenHeader, token)
	status, _, _ := needsYouPress(tokened, "Yes")
	assert.Equal(t, http.StatusForbidden, status, "and the press check refuses it on its own too")
}

func TestHubMergeKeepsOnlyAOneTimePermissionMenu(t *testing.T) {
	body := []byte(`{"counts":{"agent":2},"items":[` +
		`{"kind":"agent","id":"agent:s1","line":"Wants to run: git rebase origin/main","permission":true,"options":[{"n":1,"label":"Yes, proceed (y)"},{"n":3,"label":"No, and tell Codex what to do differently (esc)"}]},` +
		`{"kind":"agent","id":"agent:s2","line":"x","permission":true,"options":[{"n":1,"label":"Yes, proceed"},{"n":2,"label":"Yes, and don't ask again"},{"n":3,"label":"No"}]}]}`)
	got, _, ok := rebuildRemoteNeeds("m2", body)
	require.True(t, ok)
	require.Len(t, got, 2)
	assert.True(t, got[0].Permission)
	assert.Equal(t, []NeedsYouOption{{N: 1, Label: "Yes, proceed (y)"}, {N: 3, Label: "No, and tell Codex what to do differently (esc)"}}, got[0].Options, "a computer's one-time Yes and No are kept")
	assert.Nil(t, got[1].Options, "a computer that offers a lasting grant has its menu dropped whole")
}

// (b): a prompt the hooks never reported, seen only on the screen, is a Needs you item naming the agent once it has stood for its minutes, and a permission menu there offers no lasting grant either.
func TestAPermissionPromptOnlyTheScreenSawIsANeedsYouItemWithNoLastingGrant(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-0000002125b6"
	name := "codex-" + sid
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "codex", AgentName: name, WorkingDir: "/tmp/test"}))
	terminal.addSession(name, "/tmp/test")
	terminal.outputs[name] = codexExecScreen(t)
	t0 := time.Now().Add(-6 * time.Minute)
	h.dialogPass(ctx, t0)
	h.dialogPass(ctx, t0.Add(15*time.Second))

	items, err := h.NeedsYouAgents(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
	require.NoError(t, err)
	require.Len(t, items, 1, "the screen-only prompt is in Needs you")
	assert.Equal(t, name, items[0].From, "it names the agent")
	assert.True(t, items[0].Dialog)
	assert.Equal(t, DialogWords, items[0].Line)
	for _, o := range items[0].Options {
		assert.True(t, oneTimeChoice(o.Label), "no lasting grant is offered: %q", o.Label)
	}
}
