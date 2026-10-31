package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/opencode"
	"github.com/subgentic/coral/internal/permreview"
	"github.com/subgentic/coral/internal/store"
)

var openBash = opencode.PermissionRequest{ID: "per_bash1", SessionID: "ses_abc123", Permission: "bash", Command: "echo hello", Patterns: []string{"echo hello"}, Always: []string{"echo hello"}, At: time.Now()}
var openEdit = opencode.PermissionRequest{ID: "per_edit1", SessionID: "ses_abc123", Permission: "edit", File: "/work/ask.txt", At: time.Now().Add(-time.Second)}

func TestOnlyTheDefaultModeStartsOpencodeAskFirst(t *testing.T) {
	for mode, want := range map[string]bool{"default": true, "bypassPermissions": false, "auto": false, "dontAsk": false, "acceptEdits": false, "plan": false, "": false} {
		assert.Equal(t, want, opencodeAsks(mode), "%q", mode)
		f := &fakeOpencode{server: fakeServer{url: "http://127.0.0.1:1", major: 1, file: "/f"}}
		h := &SessionsHandler{opencode: f}
		_, err := h.launchCommand(context.Background(), agent.GetAgent(at.Opencode), agent.LaunchParams{SessionID: "sid", PermissionMode: mode})
		require.NoError(t, err)
		require.Len(t, f.asked, 1)
		assert.Equal(t, want, f.asked[0], "the server is started ask first only for %q", "default")
	}
}

func TestAnOpencodeAgentsOpenRequestIsTheCardInTheChat(t *testing.T) {
	h := &SessionsHandler{opencode: &fakeOpencode{perms: []opencode.PermissionRequest{openBash, openEdit}}}
	reply := map[string]any{}
	h.addNeedsInput(httptest.NewRequest("GET", "/chat?session_id=sid", nil), reply, "name", at.Opencode, "sid")
	pending, ok := reply["pending"].(pendingTool)
	require.True(t, ok, "the newest request is the card")
	assert.Equal(t, "per_bash1", pending.ToolUseID)
	assert.Equal(t, "bash", pending.ToolName)
	assert.Equal(t, "echo hello", pending.Input["command"])
	screen, ok := reply["prompt_options"].(promptScreen)
	require.True(t, ok)
	assert.Equal(t, "opencode wants to run: echo hello", screen.Question)
	assert.Equal(t, "per_bash1", screen.AskID, "an answer is for this request, not for whatever is open when it arrives")
	require.Len(t, screen.Options, 3)
	assert.Equal(t, []string{"Allow once", "Allow always: do not ask again for echo hello", "Reject"}, []string{screen.Options[0].Label, screen.Options[1].Label, screen.Options[2].Label})
	assert.True(t, screen.Options[0].Selected, "Allow once is the default")
	assert.False(t, screen.Options[1].Selected)

	none := map[string]any{}
	(&SessionsHandler{opencode: &fakeOpencode{}}).addNeedsInput(httptest.NewRequest("GET", "/chat?session_id=sid", nil), none, "name", at.Opencode, "sid")
	assert.Nil(t, none["pending"])
	assert.NotContains(t, none, "prompt_options", "nothing is asked: no card")
	assert.Equal(t, "opencode wants to edit /work/ask.txt", opencodeQuestion(openEdit))
}

func answerOpencode(h *SessionsHandler, n int, label, askID string) (int, map[string]any) {
	w := httptest.NewRecorder()
	h.answerOpencodePermission(w, httptest.NewRequest("POST", "/answer-prompt", nil), "sid", n, label, askID)
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return w.Code, body
}

func TestAnAnswerGoesToTheServerOnlyForTheRequestItWasDrawnFor(t *testing.T) {
	f := &fakeOpencode{perms: []opencode.PermissionRequest{openBash}}
	h := &SessionsHandler{opencode: f}
	for n, want := range map[int]string{1: "once", 2: "always", 3: "reject"} {
		f.replied = nil
		code, body := answerOpencode(h, n, opencodeCardOptions(openBash)[n-1].Label, "per_bash1")
		assert.Equal(t, http.StatusOK, code, "n=%d", n)
		assert.Equal(t, true, body["ok"])
		assert.Equal(t, []string{"sid|per_bash1|" + want}, f.replied, "n=%d", n)
	}

	f.replied = nil
	code, _ := answerOpencode(h, 1, "Allow once", "")
	assert.Equal(t, http.StatusBadRequest, code, "no ask id: refused")
	code, _ = answerOpencode(h, 1, "Reject", "per_bash1")
	assert.Equal(t, http.StatusConflict, code, "the label is not that option's: the prompt changed")
	code, _ = answerOpencode(h, 4, "Allow once", "per_bash1")
	assert.Equal(t, http.StatusConflict, code, "an option that does not exist")
	code, body := answerOpencode(h, 1, "Allow once", "per_other")
	assert.Equal(t, http.StatusConflict, code, "another request is open now: not answered")
	assert.Equal(t, "ask_changed", body["code"])
	assert.Empty(t, f.replied, "none of those reached the server")

	f.replyErr = opencode.ErrPermissionGone
	code, _ = answerOpencode(h, 1, "Allow once", "per_bash1")
	assert.Equal(t, http.StatusConflict, code, "answered in the terminal meanwhile")
	f.replyErr = errors.New("connection refused")
	code, body = answerOpencode(h, 1, "Allow once", "per_bash1")
	assert.Equal(t, http.StatusBadGateway, code)
	assert.NotContains(t, body["error"], "refused", "the server's own words are not shown")
	code, _ = answerOpencode(&SessionsHandler{}, 1, "Allow once", "per_bash1")
	assert.Equal(t, http.StatusConflict, code, "no server runtime: nothing is open")
}

func cardOf(t *testing.T, f *fakeOpencode) (pendingTool, promptScreen) {
	t.Helper()
	reply := map[string]any{}
	(&SessionsHandler{opencode: f}).addNeedsInput(httptest.NewRequest("GET", "/chat?session_id=sid", nil), reply, "name", at.Opencode, "sid")
	pending, ok := reply["pending"].(pendingTool)
	require.True(t, ok)
	screen, ok := reply["prompt_options"].(promptScreen)
	require.True(t, ok)
	return pending, screen
}

func TestARequestThatCannotBeShownWholeOrHoldsHiddenCharactersCanOnlyBeRejected(t *testing.T) {
	long := permreview.Of(strings.Repeat("a", 600))
	assert.False(t, long.Cut, "600 bytes fit the box")
	cases := map[string]opencode.PermissionRequest{
		"clean 400 bytes": {ID: "per_c", SessionID: "ses_abc123", Permission: "bash", Command: strings.Repeat("a", 400), At: time.Now()},
		"clean 600 bytes": {ID: "per_c", SessionID: "ses_abc123", Permission: "bash", Command: strings.Repeat("a", 600), At: time.Now()},
		"over the box":    {ID: "per_c", SessionID: "ses_abc123", Permission: "bash", Command: strings.Repeat("a", permreview.MaxBytes), Cut: true, At: time.Now()},
		"hidden char":     {ID: "per_c", SessionID: "ses_abc123", Permission: "bash", Command: "ls <U+202E>gpj.txt", Hidden: true, At: time.Now()},
	}
	for name, req := range cases {
		f := &fakeOpencode{perms: []opencode.PermissionRequest{req}}
		pending, screen := cardOf(t, f)
		only := req.Cut || req.Hidden
		assert.Equal(t, only, pending.Input["only_reject"] == true, name)
		if only {
			require.Len(t, screen.Options, 1, name)
			assert.Equal(t, "Reject", screen.Options[0].Label, name)
			assert.NotEmpty(t, pending.Input["note"], "%s: says so in words", name)
			h := &SessionsHandler{opencode: f}
			code, _ := answerOpencode(h, 1, "Reject", "per_c")
			assert.Equal(t, http.StatusOK, code, name)
			assert.Equal(t, []string{"sid|per_c|reject"}, f.replied, name)
			f.replied = nil
			code, _ = answerOpencode(h, 2, "Allow once", "per_c")
			assert.Equal(t, http.StatusConflict, code, "%s: an Allow is not an option here", name)
			assert.Empty(t, f.replied, "%s: it never reached the server", name)
		} else {
			require.Len(t, screen.Options, 3, name)
			assert.Nil(t, pending.Input["note"], name)
		}
	}
}

func TestAnAllowForAnUnallowableRequestIsRefusedEvenIfTheServerSeesIt(t *testing.T) {
	f := &fakeOpencode{perms: []opencode.PermissionRequest{{ID: "per_c", SessionID: "ses_abc123", Permission: "bash", Hidden: true}}, replyErr: opencode.ErrPermissionRefused}
	code, _ := answerOpencode(&SessionsHandler{opencode: f}, 1, "Reject", "per_c")
	assert.Equal(t, http.StatusConflict, code, "the manager's refusal is a 409, not a 502")
}

func TestTheCardSaysWhatAllowAlwaysCoversAndHowManyPatternsAreNotListed(t *testing.T) {
	req := opencode.PermissionRequest{ID: "per_m", SessionID: "ses_abc123", Permission: "bash", Patterns: []string{"git status", "git log"}, Always: []string{"git *"}, MorePatterns: 3, MoreAlways: 2, At: time.Now()}
	pending, screen := cardOf(t, &fakeOpencode{perms: []opencode.PermissionRequest{req}})
	assert.Equal(t, "and 3 more patterns", pending.Input["more_patterns"])
	require.Len(t, screen.Options, 3)
	assert.Equal(t, "Allow always: do not ask again for git * and 2 more patterns", screen.Options[1].Label)
	assert.Equal(t, "Allow once", screen.Options[0].Label)
	assert.True(t, screen.Options[0].Selected)
}

// The gates that stand before the opencode branch still apply to it (#11395): the exact target is checked first, so a name that does not match its session, or a session that is not an opencode agent's, never
// reaches the server's reply. (Who may answer at all, a person or the Hub's tier, is the identity observer's and the tunnel's tables, pinned in their own tests.)
func TestAnOpencodeAnswerPassesTheExactTargetGateBeforeTheServerIsAsked(t *testing.T) {
	server, h, terminal, ss := setupSessionsTestServer(t)
	f := &fakeOpencode{perms: []opencode.PermissionRequest{openBash}}
	h.opencode = f
	const sid = "00000000-0000-0000-0000-0000000a0c11"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "opencode", AgentName: "oc-open", WorkingDir: "/tmp/test"}))
	terminal.addSession("oc-open", "/tmp/test")
	post := func(name, agentType, session string) int {
		b, _ := json.Marshal(map[string]any{"n": 1, "label": "Allow once", "session_id": session, "agent_type": agentType, "ask_id": "per_bash1"})
		resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/answer-prompt", "application/json", bytes.NewReader(b))
		require.NoError(t, err)
		defer resp.Body.Close()
		return resp.StatusCode
	}
	for label, code := range map[string]int{
		"another agent's name":      post("someone-else", "opencode", sid),
		"the wrong agent type":      post("oc-open", "claude", sid),
		"a session that is unknown": post("oc-open", "opencode", "00000000-0000-0000-0000-0000000a0c12"),
	} {
		assert.NotEqual(t, http.StatusOK, code, label)
	}
	assert.Empty(t, f.replied, "no refused answer reached the server")
	assert.Equal(t, http.StatusOK, post("oc-open", "opencode", sid), "the control: the exact target is answered")
	assert.Equal(t, []string{sid + "|per_bash1|once"}, f.replied)
}

// The heading quotes a short request and points at the box for a long one: a 3,900-byte command in the heading filled the screen on the real build and pushed the answers out of sight.
func TestTheCardHeadingNeverRepeatsALongRequest(t *testing.T) {
	long := strings.Repeat("w000-abcdefg ", 300)
	multi := "git status\ngit log"
	for _, p := range []opencode.PermissionRequest{
		{Permission: "bash", Command: long},
		{Permission: "bash", Command: multi},
		{Permission: "edit", File: "/work/" + strings.Repeat("d/", 100) + "f.txt"},
		{Permission: "external_directory", Patterns: []string{long}},
	} {
		q := opencodeQuestion(p)
		assert.LessOrEqual(t, len(q), 160, "%s: %q", p.Permission, q[:min(len(q), 60)])
		assert.Contains(t, q, "below", "%s: it points at the box", p.Permission)
		assert.NotContains(t, q, "w000", p.Permission)
	}
	assert.Equal(t, "opencode wants to run: echo hello", opencodeQuestion(openBash), "a short one is quoted whole")
	assert.Equal(t, "opencode wants to run: "+strings.Repeat("a", maxQuestionBytes), opencodeQuestion(opencode.PermissionRequest{Permission: "bash", Command: strings.Repeat("a", maxQuestionBytes)}), "at the limit")
	assert.Contains(t, opencodeQuestion(opencode.PermissionRequest{Permission: "bash", Command: strings.Repeat("a", maxQuestionBytes+1)}), "below", "one over")
	assert.Equal(t, "opencode asks to allow an action", opencodeQuestion(opencode.PermissionRequest{Permission: strings.Repeat("k", 200)}))
}
