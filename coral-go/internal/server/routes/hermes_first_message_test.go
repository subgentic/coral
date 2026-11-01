package routes

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #11831: what a Hermes agent is told at launch is a file (agent.HermesFirstMessagePath), not the command line; its start types it as the agent's first message, once, and removes it.

func hermesStartRig(t *testing.T, agentType string) (h *SessionsHandler, term *mockSessionTerminal, dataDir, sid, name string) {
	t.Helper()
	_, h, term, _ = setupSessionsTestServer(t)
	dataDir = h.cfg.CoralDir()
	sid = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	name = naming.SessionName(agentType, sid)
	term.mu.Lock()
	term.sessions[name] = &ptymanager.PaneInfo{SessionName: name, Target: name, CurrentPath: "/tmp/p"}
	term.mu.Unlock()
	return h, term, dataDir, sid, name
}

func writeFirstMessage(t *testing.T, dataDir, team, sid, text string) string {
	t.Helper()
	p := agent.HermesFirstMessagePath(dataDir, team, sid)
	require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o700))
	require.NoError(t, os.WriteFile(p, []byte(text), 0o600))
	return p
}

func sentTo(term *mockSessionTerminal, name string) []string {
	term.mu.Lock()
	defer term.mu.Unlock()
	return append([]string(nil), term.sent[name]...)
}

func TestAHermesStartTypesItsFirstMessageOnceAndRemovesTheFile(t *testing.T) {
	h, term, data, sid, name := hermesStartRig(t, "hermes")
	p := writeFirstMessage(t, data, "team-a", sid, "You were automatically joined to message board \"team-a\". Do the thing.")
	require.NoError(t, h.startAgentCLI(context.Background(), "team-a", "hermes", name, "hermes chat"))
	require.Eventually(t, func() bool {
		for _, s := range sentTo(term, name) {
			if strings.Contains(s, "Do the thing") {
				return true
			}
		}
		return false
	}, 5*time.Second, 20*time.Millisecond, "the first message is typed")
	require.Eventually(t, func() bool { _, err := os.Stat(p); return os.IsNotExist(err) }, 5*time.Second, 20*time.Millisecond, "and its file is gone")

	// a second start of the same session has no file: nothing more is typed
	before := len(sentTo(term, name))
	require.NoError(t, h.startAgentCLI(context.Background(), "team-a", "hermes", name, "hermes chat"))
	time.Sleep(200 * time.Millisecond)
	assert.Equal(t, before+1, len(sentTo(term, name)), "only the launch line again")
}

func TestOnlyAHermesStartTypesAFirstMessageAndOnlyFromItsTeamsHome(t *testing.T) {
	h, term, data, sid, name := hermesStartRig(t, "claude")
	p := writeFirstMessage(t, data, "team-a", sid, "SHOULD NOT BE TYPED")
	require.NoError(t, h.startAgentCLI(context.Background(), "team-a", "claude", name, "claude"))
	time.Sleep(200 * time.Millisecond)
	for _, s := range sentTo(term, name) {
		assert.NotContains(t, s, "SHOULD NOT BE TYPED")
	}
	_, err := os.Stat(p)
	assert.NoError(t, err, "a file is not touched by another type's start")

	// a Hermes start in another team never reads team-a's file
	h2, term2, data2, sid2, name2 := hermesStartRig(t, "hermes")
	writeFirstMessage(t, data2, "team-a", sid2, "TEAM A ONLY")
	require.NoError(t, h2.startAgentCLI(context.Background(), "team-b", "hermes", name2, "hermes chat"))
	time.Sleep(200 * time.Millisecond)
	for _, s := range sentTo(term2, name2) {
		assert.NotContains(t, s, "TEAM A ONLY")
	}
}

// The folder is one the agent can write: a link in place of the file is never followed, and what is not the agent's own text is not typed.
func TestAHermesFirstMessageThatIsALinkIsNotTyped(t *testing.T) {
	h, term, data, sid, name := hermesStartRig(t, "hermes")
	target := filepath.Join(t.TempDir(), "secret.txt")
	require.NoError(t, os.WriteFile(target, []byte("LINKED SECRET"), 0o600))
	p := agent.HermesFirstMessagePath(data, "team-a", sid)
	require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o700))
	require.NoError(t, os.Symlink(target, p))
	require.NoError(t, h.startAgentCLI(context.Background(), "team-a", "hermes", name, "hermes chat"))
	time.Sleep(300 * time.Millisecond)
	for _, s := range sentTo(term, name) {
		assert.NotContains(t, s, "LINKED SECRET")
	}
	b, err := os.ReadFile(target)
	require.NoError(t, err)
	assert.Equal(t, "LINKED SECRET", string(b), "the target is untouched")
}

// Hermes takes 10 to 25 s to draw its screen (and about a minute more the first time in a team's home): text typed before "Welcome to Hermes Agent!" is on screen is lost. The first message waits for that line
// (the tester's capture: the input box's placeholder rotates, so it is no marker), then a few seconds more. A terminal that cannot show a screen is typed to, as the gate does.
func TestAHermesFirstMessageWaitsForTheWelcomeLine(t *testing.T) {
	_, h, mock, _ := setupSessionsTestServer(t)
	term := &loginScreenTerminal{mockSessionTerminal: mock}
	h.terminal = term
	h.hermesSettle = 10 * time.Millisecond
	data := h.cfg.CoralDir()
	sid := "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	name := naming.SessionName("hermes", sid)
	mock.mu.Lock()
	mock.sessions[name] = &ptymanager.PaneInfo{SessionName: name, Target: name, CurrentPath: "/tmp/p"}
	mock.mu.Unlock()
	writeFirstMessage(t, data, "team-a", sid, "You were automatically joined to message board \"team-a\". Go.")

	term.set("Preparing the isolated Hermes runtime...\n")
	h.deliverHermesFirstMessage("team-a", name)
	time.Sleep(400 * time.Millisecond)
	for _, s := range sentTo(mock, name) {
		assert.NotContains(t, s, "automatically joined", "not typed while Hermes is still starting")
	}
	term.set("Ask anything, or type / for commands…\n") // the placeholder is not the marker
	time.Sleep(300 * time.Millisecond)
	for _, s := range sentTo(mock, name) {
		assert.NotContains(t, s, "automatically joined")
	}
	term.set("Welcome to Hermes Agent! Type your message or /help for commands.\n")
	require.Eventually(t, func() bool {
		for _, s := range sentTo(mock, name) {
			if strings.Contains(s, "automatically joined") {
				return true
			}
		}
		return false
	}, 5*time.Second, 20*time.Millisecond)
}

// #11852 (b): a Hermes that never shows the welcome line (worded differently by another version) must not leave the agent silently without its protocol: nothing is typed (the input box is not known to be
// there), and the agent's feed gets a notice that says so, which changes no state.
func TestAHermesThatNeverShowsItsWelcomeLineGetsANoticeAndNothingTyped(t *testing.T) {
	_, h, mock, ss := setupSessionsTestServer(t)
	term := &loginScreenTerminal{mockSessionTerminal: mock}
	h.terminal = term
	h.hermesFirstWait = 300 * time.Millisecond
	data := h.cfg.CoralDir()
	ctx := context.Background()
	sid := "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	name := naming.SessionName("hermes", sid)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "hermes", AgentName: "repo", WorkingDir: "/tmp/p"}))
	mock.mu.Lock()
	mock.sessions[name] = &ptymanager.PaneInfo{SessionName: name, Target: name, CurrentPath: "/tmp/p"}
	mock.mu.Unlock()
	writeFirstMessage(t, data, "", sid, "You were automatically joined to message board \"team-a\". Go.")
	term.set("Some other version's banner\n> \n")

	h.deliverHermesFirstMessage("", name)
	var notice string
	require.Eventually(t, func() bool {
		s := sid
		evs, err := h.ts.ListAgentEvents(ctx, "repo", 20, &s)
		require.NoError(t, err)
		for _, e := range evs {
			if e.EventType == "agent_notice" {
				notice = e.Summary
				return true
			}
		}
		return false
	}, 5*time.Second, 20*time.Millisecond)
	assert.Contains(t, notice, "first message")
	assert.Contains(t, notice, "not typed")
	for _, s := range sentTo(mock, name) {
		assert.NotContains(t, s, "automatically joined")
	}
	st := h.deriveSingleSessionState(ctx, sid, 0)
	assert.False(t, st.Working)
	assert.False(t, st.NeedsInput, "the notice changes no state")
}
