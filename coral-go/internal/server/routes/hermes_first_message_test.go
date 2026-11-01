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
