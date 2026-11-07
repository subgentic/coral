package jsonl

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14345 (Security's read): the server closes an agent's own question when its MAIN thread wrote an assistant entry after it. A subagent's entries (isSidechain) run beside a waiting main thread and are not
// the agent going on, so they never count; nor do the tool-result carriers (user entries) or Claude Code's own "<synthetic>" assistant entries. TranscriptAssistantAt is that time, from what a turn read found.
func TestTranscriptAssistantAtCountsOnlyTheMainThreadsAssistantEntries(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	sid := "00000000-0000-4000-8000-000000014345"
	path := filepath.Join(dir, "x", sid+".jsonl")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
	at := func(s string) time.Time { v, err := time.Parse(time.RFC3339Nano, s); require.NoError(t, err); return v }
	appendLines(t, path,
		`{"sessionId":"`+sid+`","isSidechain":false,"type":"user","message":{"role":"user","content":"ask me"},"timestamp":"2026-11-07T12:00:00Z"}`,
		`{"sessionId":"`+sid+`","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-5-5","role":"assistant","content":[{"type":"tool_use","id":"toolu_q","name":"AskUserQuestion","input":{}}]},"timestamp":"2026-11-07T12:00:05Z"}`,
	)
	r := NewSessionReader()
	assert.True(t, r.TranscriptAssistantAt(sid).IsZero(), "nothing read yet: it never reads the file itself")
	r.ReadClaudeTurnEvent(sid, "")
	assert.Equal(t, at("2026-11-07T12:00:05Z"), r.TranscriptAssistantAt(sid), "the main thread's assistant entry")

	appendLines(t, path,
		// a subagent beside the waiting question
		`{"sessionId":"`+sid+`","isSidechain":true,"type":"assistant","message":{"model":"claude-haiku-5-5","role":"assistant","content":[{"type":"text","text":"working"}]},"timestamp":"2026-11-07T12:01:00Z"}`,
		// a tool-result carrier (a user entry) and Claude Code's own synthetic assistant entry
		`{"sessionId":"`+sid+`","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"ok"}]},"timestamp":"2026-11-07T12:02:00Z"}`,
		`{"sessionId":"`+sid+`","isSidechain":false,"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[]},"timestamp":"2026-11-07T12:03:00Z"}`,
		// an API error, as a real transcript has it: a main-thread assistant entry of the synthetic model, with the error's name (decided on purpose: it is the CLI's own record of a failed call, not the agent going on past its question)
		`{"sessionId":"`+sid+`","isSidechain":false,"type":"assistant","error":"rate_limit","isApiErrorMessage":true,"message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"limit"}]},"timestamp":"2026-11-07T12:03:30Z"}`,
	)
	r.ReadClaudeTurnEvent(sid, "")
	assert.Equal(t, at("2026-11-07T12:00:05Z"), r.TranscriptAssistantAt(sid), "a subagent's entry, a tool result, a synthetic entry and an API error do not move it")

	appendLines(t, path, `{"sessionId":"`+sid+`","isSidechain":false,"type":"assistant","message":{"model":"claude-opus-5-5","role":"assistant","content":[{"type":"tool_use","id":"toolu_r","name":"Read","input":{}}]},"timestamp":"2026-11-07T12:04:00Z"}`)
	r.ReadClaudeTurnEvent(sid, "")
	assert.Equal(t, at("2026-11-07T12:04:00Z"), r.TranscriptAssistantAt(sid), "the main thread went on")

	// An entry with no isSidechain field (an older Claude Code) is the main thread's.
	appendLines(t, path, `{"sessionId":"`+sid+`","type":"assistant","message":{"model":"claude-opus-5-5","role":"assistant","content":[]},"timestamp":"2026-11-07T12:05:00Z"}`)
	r.ReadClaudeTurnEvent(sid, "")
	assert.Equal(t, at("2026-11-07T12:05:00Z"), r.TranscriptAssistantAt(sid), "no field: the main thread's")

	// A session with no transcript read, and a Codex session, have none.
	assert.True(t, NewSessionReader().TranscriptAssistantAt("00000000-0000-4000-8000-000000000000").IsZero())
}
