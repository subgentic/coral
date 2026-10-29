package jsonl

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #11097: the last message of a session (who said it, the text, when) for the phone UI's list, read from the transcript's tail by the same entry parsers the chat uses. Coral's own deliveries (a nudge,
// a task notice) are skipped: the row shows what the agent and the person said.

func TestLastMessage_Claude(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	sid := "11111111-0000-4000-8000-000000000001"
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	lines := []string{
		`{"type":"user","timestamp":"2026-10-29T10:00:00.000Z","message":{"content":"Please fix the login bug"}}`,
		`{"type":"assistant","timestamp":"2026-10-29T10:00:05.000Z","message":{"content":[{"type":"text","text":"I found it in auth.go and fixed it."}]}}`,
		`{"type":"assistant","timestamp":"2026-10-29T10:00:06.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"go test"}}]}}`,
		`{"type":"user","timestamp":"2026-10-29T10:00:07.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`,
		`{"type":"user","timestamp":"2026-10-29T10:00:08.000Z","message":{"content":"You have 1 unread message on the message board. Run 'coral-board read' to see them."}}`,
	}
	require.NoError(t, os.WriteFile(filepath.Join(project, sid+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	m, ok := NewSessionReader().LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "assistant", m.Role, "a tool call alone and Coral's nudge are not the last message: the reply before them is")
	assert.Equal(t, "I found it in auth.go and fixed it.", m.Text)
	assert.Equal(t, "2026-10-29T10:00:05.000Z", m.At)
}

func TestLastMessage_UserWhenThePersonSpokeLast(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	sid := "11111111-0000-4000-8000-000000000002"
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	lines := []string{
		`{"type":"assistant","timestamp":"2026-10-29T10:00:05.000Z","message":{"content":[{"type":"text","text":"Done."}]}}`,
		`{"type":"user","timestamp":"2026-10-29T10:01:00.000Z","message":{"content":"Now   add\n\ttests   please"}}`,
	}
	require.NoError(t, os.WriteFile(filepath.Join(project, sid+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	m, ok := NewSessionReader().LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "user", m.Role)
	assert.Equal(t, "Now add tests please", m.Text, "plain text on one line")
}

func TestLastMessage_Codex(t *testing.T) {
	dir := t.TempDir()
	sid := "019e9db7-58df-7082-a954-7305c01b1490"
	codexHome := filepath.Join(dir, ".codex")
	sessionDir := filepath.Join(codexHome, "sessions", "2026", "10", "25")
	require.NoError(t, os.MkdirAll(sessionDir, 0o755))
	t.Setenv("CODEX_HOME", codexHome)
	fixture, err := os.ReadFile(filepath.Join("testdata", "codex_replies_7419.jsonl"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(sessionDir, "rollout-2026-10-25T04-56-00-"+sid+".jsonl"), fixture, 0o644))
	m, ok := NewSessionReader().LastMessage(sid, "", at.Codex)
	require.True(t, ok)
	assert.Equal(t, "assistant", m.Role)
	assert.True(t, strings.HasPrefix(m.Text, "REPLY7419-TWO"), m.Text)
	assert.NotEmpty(t, m.At)
}

func TestLastMessage_Agy(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ANTIGRAVITY_DATA_DIR", filepath.Join(dir, "brain"))
	sid := "14c7245b-9fb4-67de-871c-a03f6186ed30"
	logs := filepath.Join(dir, "brain", "conv-1", ".system_generated", "logs")
	require.NoError(t, os.MkdirAll(logs, 0o755))
	lines := []string{
		fmt.Sprintf(`{"step_index":0,"type":"USER_INPUT","created_at":"2026-10-29T10:00:00Z","content":"%s %s build the page"}`, at.CoralSessionMarkerPrefix, sid),
		`{"step_index":1,"type":"PLANNER_RESPONSE","created_at":"2026-10-29T10:00:09Z","content":"The page is built."}`,
	}
	require.NoError(t, os.WriteFile(filepath.Join(logs, "transcript.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	m, ok := NewSessionReader().LastMessage(sid, "/ws", at.Agy)
	require.True(t, ok)
	assert.Equal(t, "assistant", m.Role)
	assert.Equal(t, "The page is built.", m.Text)
}

func TestLastMessage_Pi(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join("testdata", "pi-1.4.0", "session.jsonl"))
	require.NoError(t, err)
	piFixtureHome(t, piTestSession, fixture)
	m, ok := NewSessionReader().LastMessage(piTestSession, "/work/pi-project", at.Pi)
	require.True(t, ok)
	assert.Equal(t, "assistant", m.Role)
	assert.Equal(t, "FIXTURE-ASSISTANT-3 answer", m.Text, "the last reply's text, past the tool calls and the thinking")
}

func TestLastMessage_NothingYet(t *testing.T) {
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
	_, ok := NewSessionReader().LastMessage("11111111-0000-4000-8000-000000000003", "", at.Claude)
	assert.False(t, ok, "no transcript, no last message")
	_, ok = NewSessionReader().LastMessage("not-a-session-id", "", at.Claude)
	assert.False(t, ok)
}

// The tail is read, never the whole file; an unchanged file is not read again; a changed one is.
func TestLastMessage_ReadsTheTailAndIsCachedByTheFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	sid := "11111111-0000-4000-8000-000000000004"
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	path := filepath.Join(project, sid+".jsonl")
	var b strings.Builder
	for i := 0; i < 20000; i++ { // a long session: about 3 MB
		fmt.Fprintf(&b, `{"type":"assistant","timestamp":"2026-10-29T10:00:00.000Z","message":{"content":[{"type":"text","text":"old message number %d with some padding to make the line longer"}]}}`+"\n", i)
	}
	b.WriteString(`{"type":"user","timestamp":"2026-10-29T11:00:00.000Z","message":{"content":"the newest"}}` + "\n")
	require.NoError(t, os.WriteFile(path, []byte(b.String()), 0o644))

	var bytesRead int64
	lastMessageReadHook = func(n int64) { bytesRead += n }
	t.Cleanup(func() { lastMessageReadHook = nil })
	r := NewSessionReader()
	m, ok := r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "the newest", m.Text)
	assert.LessOrEqual(t, bytesRead, int64(lastMessageTail), "one tail read of a 3 MB file")

	bytesRead = 0
	for i := 0; i < 10; i++ {
		_, _ = r.LastMessage(sid, "", at.Claude)
	}
	assert.Zero(t, bytesRead, "an unchanged file is not read again")

	require.NoError(t, os.WriteFile(path, append([]byte(b.String()), []byte(`{"type":"assistant","timestamp":"2026-10-29T12:00:00.000Z","message":{"content":[{"type":"text","text":"even newer"}]}}`+"\n")...), 0o644))
	require.NoError(t, os.Chtimes(path, time.Now().Add(time.Second), time.Now().Add(time.Second)))
	m, ok = r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "even newer", m.Text, "a changed file is read again")
}

// Cost: 50 sessions of 300 KB each read in one list pass cost one bounded tail read each the first time and nothing after.
func TestLastMessage_FiftySessionsCost(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	var ids []string
	for s := 0; s < 50; s++ {
		sid := fmt.Sprintf("22222222-0000-4000-8000-%012d", s)
		ids = append(ids, sid)
		var b strings.Builder
		for i := 0; i < 1500; i++ {
			fmt.Fprintf(&b, `{"type":"assistant","timestamp":"2026-10-29T10:00:00.000Z","message":{"content":[{"type":"text","text":"message %d of session %d, padded out to a realistic line length for a transcript"}]}}`+"\n", i, s)
		}
		require.NoError(t, os.WriteFile(filepath.Join(project, sid+".jsonl"), []byte(b.String()), 0o644))
	}
	var bytesRead int64
	lastMessageReadHook = func(n int64) { bytesRead += n }
	t.Cleanup(func() { lastMessageReadHook = nil })
	r := NewSessionReader()
	start := time.Now()
	for _, sid := range ids {
		m, ok := r.LastMessage(sid, "", at.Claude)
		require.True(t, ok)
		assert.Contains(t, m.Text, "message 1499")
	}
	first := time.Since(start)
	assert.LessOrEqual(t, bytesRead, int64(50*lastMessageTail), "one bounded tail read per session")
	bytesRead = 0
	start = time.Now()
	for _, sid := range ids {
		_, _ = r.LastMessage(sid, "", at.Claude)
	}
	assert.Zero(t, bytesRead, "the second pass reads nothing")
	t.Logf("50 sessions: first pass %v (%d bytes budget), cached pass %v", first, 50*lastMessageTail, time.Since(start))
}

// #11123: a changed file is read from where the last read ended, not from its tail again: what a poll reads follows what the agent wrote, however long the file and however big its last line.
func TestLastMessage_ReadsOnlyWhatWasAppended(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	sid := "11111111-0000-4000-8000-000000000005"
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	path := filepath.Join(project, sid+".jsonl")
	line := func(role, text string) string {
		if role == "user" {
			return `{"type":"user","timestamp":"2026-10-29T10:00:00.000Z","message":{"content":"` + text + `"}}` + "\n"
		}
		return `{"type":"assistant","timestamp":"2026-10-29T10:00:01.000Z","message":{"content":[{"type":"text","text":"` + text + `"}]}}` + "\n"
	}
	var seed strings.Builder
	for i := 0; i < 5000; i++ { // about 600 KB
		seed.WriteString(line("assistant", fmt.Sprintf("old %d padded to make the line a realistic length for a transcript entry", i)))
	}
	require.NoError(t, os.WriteFile(path, []byte(seed.String()), 0o644))
	var bytesRead int64
	lastMessageReadHook = func(n int64) { bytesRead += n }
	t.Cleanup(func() { lastMessageReadHook = nil })
	r := NewSessionReader()
	_, ok := r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)

	appendLines := func(s string) {
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		require.NoError(t, err)
		_, err = f.WriteString(s)
		require.NoError(t, err)
		require.NoError(t, f.Close())
		future := time.Now().Add(time.Second)
		require.NoError(t, os.Chtimes(path, future, future))
	}
	add := line("user", "what next")
	bytesRead = 0
	appendLines(add)
	m, ok := r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "what next", m.Text)
	assert.Equal(t, "user", m.Role)
	assert.LessOrEqual(t, bytesRead, int64(len(add)+lastMessageAnchor), "only the appended line was read, and the anchor bytes before it")

	// An append that holds no message (a tool call alone) leaves the last message as it was.
	toolOnly := `{"type":"assistant","timestamp":"2026-10-29T10:01:00.000Z","message":{"content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"ls"}}]}}` + "\n"
	bytesRead = 0
	appendLines(toolOnly)
	m, ok = r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "what next", m.Text, "nothing new to say: the last message stays")
	assert.LessOrEqual(t, bytesRead, int64(len(toolOnly)+lastMessageAnchor))

	// A line still being written (no newline yet) is not read as a message, and is read whole once it ends.
	half := line("assistant", "half written")
	bytesRead = 0
	appendLines(half[:len(half)/2])
	m, _ = r.LastMessage(sid, "", at.Claude)
	assert.Equal(t, "what next", m.Text)
	appendLines(half[len(half)/2:])
	m, _ = r.LastMessage(sid, "", at.Claude)
	assert.Equal(t, "half written", m.Text)
	assert.LessOrEqual(t, bytesRead, int64(2*len(half)+2*lastMessageAnchor), "the part line and the rest, not the tail")

	// A file that shrank (replaced) is read again from its end.
	require.NoError(t, os.WriteFile(path, []byte(line("user", "a fresh start")), 0o644))
	future := time.Now().Add(2 * time.Second)
	require.NoError(t, os.Chtimes(path, future, future))
	m, ok = r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "a fresh start", m.Text)

	// A huge appended chunk is bounded: at most lastMessageTailMax is read, from its end.
	bytesRead = 0
	big := strings.Repeat(line("assistant", "filler filler filler filler filler filler filler"), 200000) // about 20 MB
	appendLines(big + line("user", "the very last"))
	m, ok = r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "the very last", m.Text)
	assert.LessOrEqual(t, bytesRead, int64(lastMessageTailMax)+int64(lastMessageTail), "never more than the bound")
}
