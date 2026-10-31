package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/opencode"
)

var openBash = opencode.PermissionRequest{ID: "per_bash1", SessionID: "ses_abc123", Permission: "bash", Command: "echo hello", Patterns: []string{"echo hello"}, At: time.Now()}
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
	assert.Equal(t, []string{"Allow once", "Allow always", "Reject"}, []string{screen.Options[0].Label, screen.Options[1].Label, screen.Options[2].Label})

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
		code, body := answerOpencode(h, n, opencodeOptions[n-1].Label, "per_bash1")
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
