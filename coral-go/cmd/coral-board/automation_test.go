package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

func TestTheAutomationNamesMatchTheServers(t *testing.T) {
	assert.Equal(t, store.AutomationTokenEnv, automationTokenEnv)
	assert.Equal(t, store.AutomationBoardEnv, automationBoardEnv)
	assert.Equal(t, store.AutomationTokenHeader, automationTokenHeader)
}

// In an automation step coral-board has one command, "post TEXT" or "post -": no flag, no team, no sender, no other command.
func TestInAnAutomationStepCoralBoardOnlyPosts(t *testing.T) {
	for _, args := range [][]string{
		nil, {"read"}, {"task", "list"}, {"subscribers"}, {"post"}, {"post", "a", "b"}, {"post", "--ask", "@Operator x"}, {"post", "--as", "Operator", "x"},
		{"post", "--board", "other", "x"}, {"post", "--task", "3", "x"}, {"join", "p", "Dev"}, {"--help"},
	} {
		_, err := automationPostText(args, strings.NewReader(""))
		assert.Error(t, err, "%v", args)
	}
	got, err := automationPostText([]string{"post", "2 alerts"}, strings.NewReader(""))
	require.NoError(t, err)
	assert.Equal(t, "2 alerts", got)
	got, err = automationPostText([]string{"post", "-"}, strings.NewReader("from stdin\nline two"))
	require.NoError(t, err)
	assert.Equal(t, "from stdin\nline two", got)
	_, err = automationPostText([]string{"post", "-"}, strings.NewReader(strings.Repeat("x", maxAutomationStdin+1)))
	assert.Error(t, err, "a post that is too long is refused before it is sent")
}

// The post goes to the automation route of the step's team with the run's token and no other credential; a server's refusal is shown and exits 1.
func TestAnAutomationStepsPostGoesToItsRouteWithTheTokenAlone(t *testing.T) {
	var gotPath, gotToken, gotCLI, gotSession string
	var gotBody map[string]string
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotToken, gotCLI, gotSession = r.URL.Path, r.Header.Get(automationTokenHeader), r.Header.Get("X-Coral-CLI-Auth"), r.Header.Get(store.SessionTokenHeader)
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status == http.StatusOK {
			_, _ = io.WriteString(w, `{"id":7,"sender":"Automation: prod-alerts"}`)
		} else {
			_, _ = io.WriteString(w, `{"message":"an automation may not mention the Operator or everyone"}`)
		}
	}))
	defer srv.Close()
	t.Setenv("CORAL_URL", srv.URL)
	t.Setenv(automationTokenEnv, "au1.abc")
	t.Setenv(automationBoardEnv, "ops team")
	var out, errb bytes.Buffer
	code := runAutomationCommand([]string{"post", "2 alerts firing"}, strings.NewReader(""), &out, &errb)
	require.Equal(t, 0, code, errb.String())
	assert.Equal(t, "/api/board/ops%20team/automation/post", strings.ReplaceAll(gotPath, " ", "%20"))
	assert.Equal(t, "au1.abc", gotToken)
	assert.Empty(t, gotCLI, "never signed as the Operator")
	assert.Empty(t, gotSession)
	assert.Equal(t, map[string]string{"content": "2 alerts firing"}, gotBody, "the text and nothing else: the sender is the server's")
	assert.Contains(t, out.String(), "Automation: prod-alerts")

	status = http.StatusBadRequest
	out.Reset()
	errb.Reset()
	code = runAutomationCommand([]string{"post", "@Operator help"}, strings.NewReader(""), &out, &errb)
	assert.Equal(t, 1, code)
	assert.Contains(t, errb.String(), "may not mention the Operator")

	t.Setenv(automationBoardEnv, "")
	errb.Reset()
	assert.Equal(t, 2, runAutomationCommand([]string{"post", "x"}, strings.NewReader(""), &out, &errb), "no team, nothing is sent")
	assert.True(t, inAutomationStep())
	t.Setenv(automationTokenEnv, "")
	assert.False(t, inAutomationStep())
}
