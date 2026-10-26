package jsonl

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/transcriptlink"
)

const (
	linkSession = "5f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b"
	linkOther   = "6f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5c"
	linkConv    = "33333333-cccc-4ccc-8ccc-333333333333"
	linkConv2   = "44444444-dddd-4ddd-8ddd-444444444444"
)

// writeConv writes an agy conversation's transcript: the first row is agy 1.4.2's real USER_INPUT shape; marker, when set, is the Coral session id embedded after it.
func writeConv(t *testing.T, home, conv, marker string) string {
	t.Helper()
	dir := filepath.Join(home, "brain", conv, ".system_generated", "logs")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	body := `{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-10-18T07:51:51Z","content":"<USER_REQUEST>\nhello\n</USER_REQUEST>"}` + "\n"
	if marker != "" {
		body += `{"step_index":1,"type":"USER_INPUT","content":"[CORAL_SESSION_ID: ` + marker + `]"}` + "\n"
	}
	path := filepath.Join(dir, "transcript.jsonl")
	require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
	return path
}

// #7764: agy keys its transcript by its own conversation id, and its first rows no longer carry Coral's marker. The conversation agy's own hook named for the session is found first;
// with no link (and no marker) a session finds nothing, never another session's conversation.
func TestAgyTranscriptIsFoundByTheConversationItsHookNamed(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ANTIGRAVITY_DATA_DIR", home)
	t.Setenv("HOME", t.TempDir()) // no history.jsonl, no ~/.gemini of the operator
	path := writeConv(t, home, linkConv, "")
	other := writeConv(t, home, linkConv2, "")
	_ = other

	assert.Equal(t, "", resolveAgyTranscriptStrict(linkSession), "no link and no marker: not found, and never by newest file")
	assert.Equal(t, "", resolveAgyTranscriptStrict(linkSession, t.TempDir()), "nor by a workspace that matches nothing")

	require.NoError(t, transcriptlink.BindAgy(linkSession, linkConv))
	assert.Equal(t, path, resolveAgyTranscriptStrict(linkSession), "the linked conversation")
	assert.Equal(t, path, resolveAgyTranscript(linkSession))
	assert.Equal(t, "", resolveAgyTranscriptStrict(linkOther), "another session does not get it")
}

// A link written by a nested agy, to a conversation that is marked as another session's, is not believed.
func TestAgyLinkToAConversationMarkedForAnotherSessionIsIgnored(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ANTIGRAVITY_DATA_DIR", home)
	t.Setenv("HOME", t.TempDir())
	writeConv(t, home, linkConv, linkOther)
	require.NoError(t, transcriptlink.BindAgy(linkSession, linkConv)) // a first bind needs no marker
	assert.Equal(t, "", resolveAgyTranscriptStrict(linkSession), "the transcript names another session")
	assert.NotEqual(t, "", resolveAgyTranscriptStrict(linkOther), "and is that session's by its marker")
}

// copyFixture copies a real agy 1.4.7 capture's files into a conversation folder of a temp brain.
func copyFixture(t *testing.T, home, conv, fixture string, names ...string) string {
	t.Helper()
	dir := filepath.Join(home, "brain", conv, ".system_generated", "logs")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join("testdata", "agy-1.4.7", fixture, n))
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(dir, n), b, 0o600))
	}
	return filepath.Join(dir, "transcript.jsonl")
}

// #7764, from a real Coral-launched agy 1.4.7: its transcript.jsonl cuts the first prompt (truncated_fields) before Coral's marker, which only transcript_full.jsonl, beside it,
// still has. With no hook link yet, the marker is found there, and only for the session it names.
func TestAgyMarkerIsFoundInTheFullTranscriptWhenTheCompactOneCutItOff(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ANTIGRAVITY_DATA_DIR", home)
	t.Setenv("HOME", t.TempDir())
	const mine = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	compact := copyFixture(t, home, linkConv, "launched", "transcript.jsonl", "transcript_full.jsonl")

	assert.Equal(t, "", agyFileCoralSessionID(compact), "the compact file's first row is cut before the marker")
	assert.Equal(t, mine, agyTranscriptCoralSessionID(compact), "the full file beside it has it")
	assert.Equal(t, compact, resolveAgyTranscriptStrict(mine), "the session is found by it")
	assert.Equal(t, "", resolveAgyTranscriptStrict(linkOther), "another session is not")

	// without the full file there is nothing to find it by (and nothing else is guessed)
	require.NoError(t, os.Remove(filepath.Join(filepath.Dir(compact), "transcript_full.jsonl")))
	assert.Equal(t, "", resolveAgyTranscriptStrict(mine))
}

// #7764: with the conversation linked by agy's own hook, the chat view has the real agy 1.4.7 conversation (the transcript is keyed by agy's conversation id, and its first row carries no Coral
// marker): the person's message, each reply as its own assistant message, the run_command call and its result.
func TestReadAllMessagesAgyChatThroughTheHooksLink(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ANTIGRAVITY_DATA_DIR", home)
	t.Setenv("HOME", t.TempDir())
	copyFixture(t, home, linkConv, "oneturn", "transcript.jsonl", "transcript_full.jsonl")

	reader := NewSessionReader()
	msgs, _ := reader.ReadAllMessagesContext(context.Background(), linkSession, "/work", "agy")
	assert.Empty(t, msgs, "before the hook's link the session has no transcript to read")

	require.NoError(t, transcriptlink.BindAgy(linkSession, linkConv))
	msgs, _ = NewSessionReader().ReadAllMessagesContext(context.Background(), linkSession, "/work", "agy")
	var kinds, replies []string
	for _, m := range msgs {
		kind, _ := m["type"].(string)
		kinds = append(kinds, kind)
		if text, _ := m["text"].(string); kind == "assistant" && text != "" {
			replies = append(replies, text)
		}
	}
	assert.Equal(t, []string{"user", "assistant", "tool_result", "assistant"}, kinds)
	assert.Equal(t, []string{"The contents of [sample.txt](file:///tmp/agy-capture-k8iPek/sample.txt) are `hello sample`."}, replies, "the final reply is its own message")
	assert.Equal(t, "Run a single shell command 'cat sample.txt' using run_command and then reply with its contents in one short sentence.", msgs[0]["content"])
	tools, _ := msgs[1]["tool_uses"].([]map[string]any)
	require.Len(t, tools, 1)
	assert.Equal(t, "run_command", tools[0]["name"])
	assert.Equal(t, "cat sample.txt", tools[0]["command"])
}
