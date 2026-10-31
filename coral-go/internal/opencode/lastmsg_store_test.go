package opencode

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/secfile/secfiletest"
)

// #11390: the newest message is kept on disk (redacted, then cut) when it is read, so a list of agents with no server (asleep, or after a Coral restart) shows it without starting one.
func TestTheNewestMessageIsKeptForAnAgentWithNoServer(t *testing.T) {
	cfg, _ := stubConfig(t)
	frames := filepath.Join(t.TempDir(), "frames")
	require.NoError(t, os.WriteFile(frames, []byte("data: {\"id\":\"e1\",\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"ses_abc123\"}}\n\n"), 0o600))
	t.Setenv(eventsFileVar, frames)
	m := NewManager(cfg)
	m.Redact = func(s string) (string, bool) { return strings.ReplaceAll(s, "stand-in", "[REDACTED]"), true }
	_, err := m.Ensure(context.Background(), "agent-1", "", "", "")
	require.NoError(t, err)
	waitFor(t, "the last message", func() bool { _, ok := m.AgentLastMessage("agent-1"); return ok })
	waitFor(t, "it to be kept", func() bool { _, ok := PersistedLast(cfg.DataDir, "agent-1"); return ok })
	m.Close() // the agent sleeps, or Coral restarts: no server

	fresh := NewManager(cfg)
	defer fresh.Close()
	got, ok := fresh.AgentLastMessage("agent-1")
	require.True(t, ok, "kept for an agent with no server")
	assert.Equal(t, "assistant", got.Role)
	assert.Equal(t, "hello from the [REDACTED]", got.Text, "redacted before it was written")
	raw, err := os.ReadFile(filepath.Join(lastDir(cfg.DataDir), "agent-1"))
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "stand-in", "the file never held the unredacted text")
	secfiletest.AssertPrivate(t, filepath.Join(lastDir(cfg.DataDir), "agent-1")) // 0600 on Unix, an explicit protected access list on Windows (which has no mode bits)
	_, ok = fresh.AgentLastMessage("agent-2")
	assert.False(t, ok, "another agent's is not this one's")
}

func TestAMessageThatCannotBeRedactedIsNotKeptAndOneIsCutAfterRedaction(t *testing.T) {
	dir := t.TempDir()
	persistLast(dir, "a-1", Message{Role: "assistant", Text: "secret text"}, func(string) (string, bool) { return "", false })
	_, ok := PersistedLast(dir, "a-1")
	assert.False(t, ok, "a text that cannot be checked is not kept")

	long := strings.Repeat("x", 2000)
	persistLast(dir, "a-2", Message{Role: "user", Text: long, At: "2026-10-31T00:00:00Z"}, func(s string) (string, bool) { return s, true })
	got, ok := PersistedLast(dir, "a-2")
	require.True(t, ok)
	assert.Len(t, []rune(got.Text), persistedLastRunes)

	// nothing is kept for a key that is not one, for no text, or for a role that is not said
	persistLast(dir, "../x", Message{Role: "user", Text: "t"}, nil)
	persistLast(dir, "a-3", Message{Role: "user", Text: ""}, nil)
	persistLast(dir, "a-4", Message{Role: "tool", Text: "t"}, nil)
	for _, k := range []string{"../x", "a-3", "a-4"} {
		_, ok := PersistedLast(dir, k)
		assert.False(t, ok, k)
	}
}

func TestARecordThatIsNotOneIsNotRead(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(lastDir(dir), 0o700))
	for name, content := range map[string]string{
		"bad-json": "not json",
		"bad-role": `{"role":"tool","text":"x"}`,
		"no-text":  `{"role":"user","text":""}`,
		"too-big":  `{"role":"user","text":"` + strings.Repeat("y", persistedLastMax) + `"}`,
	} {
		require.NoError(t, os.WriteFile(filepath.Join(lastDir(dir), name), []byte(content), 0o600))
		_, ok := PersistedLast(dir, name)
		assert.False(t, ok, name)
	}
	// a link planted at the record is not followed to another file
	target := filepath.Join(dir, "elsewhere")
	require.NoError(t, os.WriteFile(target, []byte(`{"role":"user","text":"from another file"}`), 0o600))
	require.NoError(t, os.Symlink(target, filepath.Join(lastDir(dir), "linked")))
	_, ok := PersistedLast(dir, "linked")
	assert.False(t, ok, "never read through a link")
}

// With no redactor nothing is kept: never the raw text (QA's SHOULD 1 on c3cca72fc).
func TestWithNoRedactorNothingIsKept(t *testing.T) {
	dir := t.TempDir()
	persistLast(dir, "a-1", Message{Role: "assistant", Text: "ghp_aB3dE5gH7jaB3dE5gH7jaB3dE5gH7jkLmNoP is a token"}, nil)
	_, ok := PersistedLast(dir, "a-1")
	assert.False(t, ok)
	_, err := os.Stat(filepath.Join(lastDir(dir), "a-1"))
	assert.True(t, os.IsNotExist(err), "no file was written")

	cfg, _ := stubConfig(t)
	frames := filepath.Join(t.TempDir(), "frames")
	require.NoError(t, os.WriteFile(frames, []byte("data: {\"id\":\"e1\",\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"ses_abc123\"}}\n\n"), 0o600))
	t.Setenv(eventsFileVar, frames)
	m := NewManager(cfg) // a manager built without a redactor
	defer m.Close()
	_, err = m.Ensure(context.Background(), "agent-2", "", "", "")
	require.NoError(t, err)
	waitFor(t, "the last message", func() bool { _, ok := m.AgentLastMessage("agent-2"); return ok })
	time.Sleep(200 * time.Millisecond)
	_, ok = PersistedLast(cfg.DataDir, "agent-2")
	assert.False(t, ok, "read and shown live, but not written to disk")
}
