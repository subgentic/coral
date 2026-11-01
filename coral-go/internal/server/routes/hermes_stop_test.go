package routes

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #11831 (the tester's capture): Escape does nothing in Hermes, and Ctrl-C at its idle prompt closes it at once ("Goodbye!"). So the Stop button's lone Escape is Ctrl-C for a Hermes agent only while a turn is
// going on, and nothing at all when it is not: the button can never close an idle Hermes. A person's own keys (the key bar's Ctrl-C) go as they are, and other agent types are untouched.

func hermesKeysRig(t *testing.T, agentType string, lastEvent string, ago time.Duration) (post func(keys string) int, sent func() []string) {
	t.Helper()
	server, h, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-0000000057f1"
	name := agentType + "-" + sid
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: agentType, AgentName: "repo", WorkingDir: "/tmp/test"}))
	terminal.addSession(name, "/tmp/test")
	if lastEvent != "" {
		s := sid
		_, err := h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "repo", SessionID: &s, EventType: lastEvent, Summary: "x", CreatedAt: time.Now().Add(-ago).UTC().Format(store.ISOFormat)})
		require.NoError(t, err)
	}
	post = func(keys string) int {
		t.Helper()
		resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/keys", "application/json", bytes.NewBufferString(`{"keys": `+keys+`, "agent_type": "`+agentType+`", "session_id": "`+sid+`"}`))
		require.NoError(t, err)
		defer resp.Body.Close()
		return resp.StatusCode
	}
	sent = func() []string {
		terminal.mu.Lock()
		defer terminal.mu.Unlock()
		return append([]string(nil), terminal.raw[name]...)
	}
	return post, sent
}

func TestStopIsCtrlCForAWorkingHermesAndNothingForAnIdleOne(t *testing.T) {
	post, sent := hermesKeysRig(t, "hermes", "prompt_submit", 30*time.Second)
	assert.Equal(t, http.StatusOK, post(`["Escape"]`))
	assert.Equal(t, []string{"C-c"}, sent(), "a turn is going on: Stop interrupts it")

	post, sent = hermesKeysRig(t, "hermes", "stop", 30*time.Second)
	assert.Equal(t, http.StatusOK, post(`["Escape"]`))
	assert.Empty(t, sent(), "idle: Ctrl-C would close Hermes, so nothing is sent")

	post, sent = hermesKeysRig(t, "hermes", "", 0)
	assert.Equal(t, http.StatusOK, post(`["Escape"]`))
	assert.Empty(t, sent(), "no event yet: Hermes is not known to be working")

	post, sent = hermesKeysRig(t, "hermes", "permission_request", time.Minute)
	assert.Equal(t, http.StatusOK, post(`["Escape"]`))
	assert.Empty(t, sent(), "an approval menu: Escape does nothing there, and Ctrl-C would deny it for the person")
}

func TestOnlyALoneEscapeOfAHermesAgentIsChangedAndOtherTypesAreNot(t *testing.T) {
	post, sent := hermesKeysRig(t, "hermes", "stop", time.Minute)
	assert.Equal(t, http.StatusOK, post(`["C-c"]`))
	assert.Equal(t, []string{"C-c"}, sent(), "a person's own key, from the key bar, goes as it is")
	assert.Equal(t, http.StatusOK, post(`["Escape","Escape"]`))
	assert.Equal(t, []string{"C-c", "Escape", "Escape"}, sent(), "two Escapes (Undo) are not the Stop button")
	assert.Equal(t, http.StatusOK, post(`["Enter"]`))
	assert.Equal(t, []string{"C-c", "Escape", "Escape", "Enter"}, sent())

	post, sent = hermesKeysRig(t, "claude", "stop", time.Minute)
	assert.Equal(t, http.StatusOK, post(`["Escape"]`))
	assert.Equal(t, []string{"Escape"}, sent(), "another agent's Escape is untouched")
}
