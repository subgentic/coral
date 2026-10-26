package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// The operator's bug (#7727): a skip notice next to "No unread board messages" contradicts itself. The skipped send is shown only while an unread board message waits, in the live row and in
// GET .../waiting alike; and Coral's own leftover that got its Enter is not a skip at all.
func TestASkippedSendIsShownOnlyWhileAnUnreadMessageWaits(t *testing.T) {
	server, handler, mock, ss := setupSessionsTestServer(t)
	term := &screenTerminal{fgSessionTerminal: newFGTerminal(mock), screen: permissionMenu}
	handler.terminal = term
	ctx := context.Background()
	name := naming.SessionName("claude", gateSID)
	mock.addSession(name, "/tmp/test")
	term.setFG(name, "node")
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: gateSID, AgentType: "claude", AgentName: "repo", WorkingDir: "/tmp/test"}))
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	handler.bs = bs
	_, err = bs.Subscribe(ctx, "team", "Dev", "Dev", name, nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "team", "Lead", "Lead", "", nil, "")
	require.NoError(t, err)
	first, err := bs.PostMessage(ctx, "team", "Lead", "please review", nil)
	require.NoError(t, err)

	// a nudge met an open prompt: skipped
	d, err := ptymanager.DeliverAutomated(ctx, ptymanager.AutomatedInput{
		Term: term, Name: name, AgentType: "claude", SessionID: gateSID, Text: "You have 1 unread message", What: "board message",
		Send: func(ctx context.Context) error {
			return term.SendInput(ctx, terminalinput.Coral, name, "You have 1 unread message", "claude", gateSID)
		},
	})
	require.NoError(t, err)
	require.Equal(t, ptymanager.Skipped, d)
	t.Cleanup(func() { ptymanager.ForgetSession(name) })

	get := func() map[string]any {
		resp, err := http.Get(server.URL + "/api/sessions/live/" + name + "/waiting?agent_type=claude&session_id=" + gateSID)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}
	out := get()
	assert.EqualValues(t, 1, out["unread"])
	skipped, _ := out["skipped"].(map[string]any)
	require.NotNil(t, skipped, "one unread and a skipped send: both are shown")
	assert.Contains(t, skipped["why"], ptymanager.SkipPrompt)
	assert.NotNil(t, skippedSendField(name, 1))

	// the agent reads the board: nothing waits, so no skip is shown (the skipped memo itself is the next delivery's to clear)
	_, _, _, err = bs.MarkReadThrough(ctx, "team", "Dev", first.ID, 0)
	require.NoError(t, err)
	out = get()
	assert.EqualValues(t, 0, out["unread"])
	assert.Nil(t, out["skipped"], "no unread message: no skip notice")
	assert.Nil(t, skippedSendField(name, 0), "and not in the live row either")

	// a new unread message after the skip: the skip is shown again until a send is typed
	_, err = bs.PostMessage(ctx, "team", "Lead", "and again", nil)
	require.NoError(t, err)
	assert.NotNil(t, get()["skipped"])
	term.show(idleInputBox)
	d, err = ptymanager.DeliverAutomated(ctx, ptymanager.AutomatedInput{
		Term: term, Name: name, AgentType: "claude", SessionID: gateSID, Text: "You have 1 unread message", What: "board message",
		Send: func(ctx context.Context) error {
			return term.SendInput(ctx, terminalinput.Coral, name, "You have 1 unread message", "claude", gateSID)
		},
	})
	require.NoError(t, err)
	require.Equal(t, ptymanager.Sent, d)
	assert.Nil(t, get()["skipped"], "the next send typed clears it")
}
