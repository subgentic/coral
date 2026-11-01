package jsonl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #11704: where an agent is now, from its transcript's newest "cwd"; only a plain absolute path of a Claude session, cached by size and time.

func currentDirFile(t *testing.T, sid string, lines ...string) string {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	p := filepath.Join(project, sid+".jsonl")
	require.NoError(t, os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	return p
}

func TestCurrentDirectoryIsTheNewestCwdAndFollowsTheAgent(t *testing.T) {
	sid := "22222222-0000-4000-8000-000000000001"
	p := currentDirFile(t, sid,
		`{"type":"user","cwd":"/work/launch","message":{"content":"hi"}}`,
		`{"type":"assistant","cwd":"/work/launch/wt-a","message":{"content":[{"type":"text","text":"moved"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"a line with no cwd"}]}}`)
	r := NewSessionReader()
	assert.Equal(t, "/work/launch/wt-a", r.CurrentDirectory(sid, "", at.Claude), "the newest line that names a directory")
	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	require.NoError(t, err)
	_, err = f.WriteString(`{"type":"assistant","cwd":"/work/launch/wt-b","message":{"content":[{"type":"text","text":"moved again"}]}}` + "\n")
	require.NoError(t, err)
	require.NoError(t, f.Close())
	assert.Equal(t, "/work/launch/wt-b", r.CurrentDirectory(sid, "", at.Claude), "a longer file is read again: the agent moved")
}

func TestCurrentDirectoryRefusesWhatIsNotAPlainAbsolutePath(t *testing.T) {
	sid := "22222222-0000-4000-8000-000000000002"
	for name, cwd := range map[string]string{
		"relative":         "wt-a",
		"a url":            "https://x.test/a",
		"with a newline":   "/work/a\\nb",
		"with an escape":   "/work/\\u001b[31m",
		"with a bidi mark": "/work/\\u202ex",
		"empty":            "",
	} {
		currentDirFile(t, sid, `{"type":"user","cwd":"`+cwd+`","message":{"content":"hi"}}`)
		assert.Equal(t, "", NewSessionReader().CurrentDirectory(sid, "", at.Claude), name)
	}
}

func TestCurrentDirectoryIsClaudeOnly(t *testing.T) {
	sid := "22222222-0000-4000-8000-000000000003"
	currentDirFile(t, sid, `{"type":"user","cwd":"/work/a","message":{"content":"hi"}}`)
	r := NewSessionReader()
	assert.Equal(t, "", r.CurrentDirectory(sid, "", at.Codex), "other agents keep the folder they were launched in")
	assert.Equal(t, "", r.CurrentDirectory("not-a-session-id", "", at.Claude))
	assert.Equal(t, "/work/a", r.CurrentDirectory(sid, "", at.Claude))
}
