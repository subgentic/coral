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

func qaClaudeLine(role, text, ts string) string {
	if role == "user" {
		return fmt.Sprintf(`{"type":"user","timestamp":%q,"message":{"content":%q}}`, ts, text)
	}
	return fmt.Sprintf(`{"type":"assistant","timestamp":%q,"message":{"content":[{"type":"text","text":%q}]}}`, ts, text)
}

func qaSetup(t *testing.T, sid string) (path string, r *SessionReader) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	return filepath.Join(project, sid+".jsonl"), NewSessionReader()
}

func qaWrite(t *testing.T, path string, lines ...string) {
	require.NoError(t, os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	// a later mtime each time, as a real rewrite has
	now := time.Now().Add(time.Duration(qaTick()) * time.Second)
	require.NoError(t, os.Chtimes(path, now, now))
}

var qaN int

func qaTick() int { qaN++; return qaN }

// A file REPLACED by a larger one (rotation, a rewrite): the new file's newest message must show, not the old file's.
func TestQAProbe_ReplacedByLargerFile(t *testing.T) {
	const sid = "11111111-0000-4000-8000-0000000000a1"
	path, r := qaSetup(t, sid)
	qaWrite(t, path, qaClaudeLine("assistant", "OLD-ANSWER", "2026-10-29T10:00:00Z"))
	m, ok := r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	require.Equal(t, "OLD-ANSWER", m.Text)
	// the replacement is bigger than the old file and its newest message is a tool-only line then a text one
	qaWrite(t, path,
		qaClaudeLine("user", "a much longer first message of the replacement file to move the offsets", "2026-10-29T11:00:00Z"),
		qaClaudeLine("assistant", "NEW-ANSWER-OF-THE-REPLACEMENT", "2026-10-29T11:00:05Z"))
	m, ok = r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "NEW-ANSWER-OF-THE-REPLACEMENT", m.Text, "a replaced (larger) file is read afresh")
}

// The replacement is LONGER than the old file but ends in lines with no text: the old file's message must not be shown.
func TestQAProbe_ReplacedByLargerFileWithNoTextAfterTheOldOffset(t *testing.T) {
	const sid = "11111111-0000-4000-8000-0000000000a2"
	path, r := qaSetup(t, sid)
	qaWrite(t, path, qaClaudeLine("assistant", "OLD-ANSWER", "2026-10-29T10:00:00Z"))
	_, _ = r.LastMessage(sid, "", at.Claude)
	big := qaClaudeLine("user", strings.Repeat("padding ", 60), "2026-10-29T11:00:00Z")
	toolOnly := `{"type":"assistant","timestamp":"2026-10-29T11:00:06.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"go test"}}]}}`
	qaWrite(t, path, big, toolOnly)
	m, ok := r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.NotEqual(t, "OLD-ANSWER", m.Text, "the old file's message is not this file's")
}

// A file rewritten to the SAME size with different text (mtime changed).
func TestQAProbe_RewrittenSameSize(t *testing.T) {
	const sid = "11111111-0000-4000-8000-0000000000a3"
	path, r := qaSetup(t, sid)
	qaWrite(t, path, qaClaudeLine("assistant", "AAAA-ONE", "2026-10-29T10:00:00Z"))
	m, _ := r.LastMessage(sid, "", at.Claude)
	require.Equal(t, "AAAA-ONE", m.Text)
	qaWrite(t, path, qaClaudeLine("assistant", "BBBB-TWO", "2026-10-29T10:00:00Z"))
	m, ok := r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "BBBB-TWO", m.Text, "a same-size rewrite with a new mtime is read afresh")
}

// A huge single line (20 MB) still being written, then finished, then a normal message after it.
func TestQAProbe_HugeLineBeingWrittenThenFinished(t *testing.T) {
	const sid = "11111111-0000-4000-8000-0000000000a4"
	path, r := qaSetup(t, sid)
	qaWrite(t, path, qaClaudeLine("assistant", "BEFORE-HUGE", "2026-10-29T10:00:00Z"))
	m, _ := r.LastMessage(sid, "", at.Claude)
	require.Equal(t, "BEFORE-HUGE", m.Text)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	require.NoError(t, err)
	defer f.Close()
	_, err = f.WriteString(`{"type":"user","timestamp":"2026-10-29T10:01:00Z","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"` + strings.Repeat("x", 20<<20)) // no newline yet
	require.NoError(t, err)
	now := time.Now().Add(5 * time.Second)
	require.NoError(t, os.Chtimes(path, now, now))
	m, ok := r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "BEFORE-HUGE", m.Text, "a huge line still being written leaves the last message as it was")
	_, err = f.WriteString("\"}]}}\n" + qaClaudeLine("assistant", "AFTER-HUGE", "2026-10-29T10:02:00Z") + "\n")
	require.NoError(t, err)
	now = now.Add(5 * time.Second)
	require.NoError(t, os.Chtimes(path, now, now))
	m, ok = r.LastMessage(sid, "", at.Claude)
	require.True(t, ok)
	assert.Equal(t, "AFTER-HUGE", m.Text, "the message after the finished huge line is found")
}

// Pi's /new starts another file in the session's folder: the newest file is the session's transcript (resolvePiTranscript), so the last message follows it.
func TestQAProbe_PiNewFileInTheSameFolder(t *testing.T) {
	data := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", data)
	const sid = "11111111-0000-4000-8000-0000000000a5"
	dir := filepath.Join(data, "pi-sessions", sid)
	require.NoError(t, os.MkdirAll(dir, 0o700))
	msg := func(role, text string) string {
		return fmt.Sprintf(`{"type":"message","timestamp":"2026-10-29T10:00:00Z","message":{"role":%q,"content":[{"type":"text","text":%q}]}}`, role, text)
	}
	a := filepath.Join(dir, "2026-10-29T10-00-00-000Z_a.jsonl")
	require.NoError(t, os.WriteFile(a, []byte(msg("assistant", "FIRST-FILE-ANSWER")+"\n"), 0o600))
	r := NewSessionReader()
	m, ok := r.LastMessage(sid, "", at.Pi)
	require.True(t, ok)
	require.Equal(t, "FIRST-FILE-ANSWER", m.Text)
	b := filepath.Join(dir, "2026-10-29T11-00-00-000Z_b.jsonl")
	require.NoError(t, os.WriteFile(b, []byte(msg("assistant", "SECOND-FILE-ANSWER")+"\n"), 0o600))
	later := time.Now().Add(10 * time.Second)
	require.NoError(t, os.Chtimes(b, later, later))
	m, ok = r.LastMessage(sid, "", at.Pi)
	require.True(t, ok)
	assert.Equal(t, "SECOND-FILE-ANSWER", m.Text, "after /new the newest file's message shows")
}
