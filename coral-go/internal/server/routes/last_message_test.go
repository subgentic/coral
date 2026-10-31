package routes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/jsonl"
)

// #11097: a row's last_message is the first 140 characters of the text, redacted like an excerpt, with the role and the time.
func TestLastMessageFieldIsCutAndRedacted(t *testing.T) {
	assert.Nil(t, lastMessageField(nil, false), "no message: the field is null")

	long := strings.Repeat("word ", 100)
	f := lastMessageField(&lastMessageSource{Role: "assistant", Text: long, At: "2026-10-29T10:00:00Z"}, false)
	require.NotNil(t, f)
	assert.Equal(t, "assistant", f["role"])
	assert.Equal(t, "2026-10-29T10:00:00Z", f["at"])
	assert.Len(t, []rune(f["text"].(string)), 140, "the first 140 characters")

	multi := strings.Repeat("é", 300)
	f = lastMessageField(&lastMessageSource{Role: "user", Text: multi}, false)
	assert.Equal(t, strings.Repeat("é", 140), f["text"], "cut by characters, never in the middle of one")

	key := "sk-ant-api03-" + strings.Repeat("aB3_x9Z-", 11) + "AA" // the shape of an Anthropic key
	f = lastMessageField(&lastMessageSource{Role: "user", Text: "my key is " + key + " ok"}, false)
	assert.NotContains(t, f["text"], key, "a secret is redacted before it leaves, as in an excerpt")
	assert.NotContains(t, f["text"], "aB3_x9Z-aB3_x9Z-", "none of it")
}

// #11354: a started agent's first reply is on its row at once. The list's row asks with whether the agent has reported an event; a transcript that was not there at the first poll is found at the next.
func TestLastMessageRowFindsAFirstReplyAtOnceForAStartedAgent(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	sid := "11111111-0000-4000-8000-0000000000aa"
	h := &SessionsHandler{jsonl: jsonl.NewSessionReader()}
	assert.Nil(t, lastMessageRow(h, sid, "", "claude", false, false), "no transcript yet: \"No messages yet\"")
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	reply := `{"type":"assistant","timestamp":"2026-10-30T10:00:05.000Z","message":{"content":[{"type":"text","text":"Hi, ready."}]}}` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(project, sid+".jsonl"), []byte(reply), 0o644))
	time.Sleep(1100 * time.Millisecond) // sleep-ok: the started session's miss is kept one second (jsonl's clock seam is not reachable from here)
	f := lastMessageRow(h, sid, "", "claude", false, true)
	require.NotNil(t, f, "the agent has reported an event: its first reply is the row's last message about a second later, not 5 s later")
	assert.Equal(t, "Hi, ready.", f["text"])
}

// #11354: a hook event for a session whose row has no last message forgets the remembered miss, and a stop (the end of a turn) sends the list at once; with a message already cached, a stop sends nothing.
func TestAHookEventForgetsTheMissAndAStopKicksTheListForAFirstReply(t *testing.T) {
	was := firstStopKicked
	firstStopKicked = &onceSet{max: 10000} // a set of its own: the package's remembers sessions for the life of the process, and a repeated run (-count=N) must start clean
	t.Cleanup(func() { firstStopKicked = was })
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	sid := "11111111-0000-4000-8000-0000000000bb"
	h := &SessionsHandler{jsonl: jsonl.NewSessionReader()}
	assert.Nil(t, lastMessageRow(h, sid, "", "claude", false, false), "no transcript yet")
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	reply := `{"type":"assistant","timestamp":"2026-10-30T10:00:05.000Z","message":{"content":[{"type":"text","text":"First reply."}]}}` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(project, sid+".jsonl"), []byte(reply), 0o644))
	assert.Nil(t, lastMessageRow(h, sid, "", "claude", false, false), "the 5 s miss stands")

	before := h.wsList.kickGen
	h.noteEventForLastMessage(sid, "tool_use")
	assert.Equal(t, before, h.wsList.kickGen, "a tool call does not send the list")
	h.noteEventForLastMessage(sid, "stop")
	assert.Equal(t, before+1, h.wsList.kickGen, "the end of the first turn does")
	f := lastMessageRow(h, sid, "", "claude", false, false)
	require.NotNil(t, f, "and the first reply is on the row at the next read")
	assert.Equal(t, "First reply.", f["text"])

	h.noteEventForLastMessage(sid, "stop")
	assert.Equal(t, before+1, h.wsList.kickGen, "a later stop, the row has its message: nothing is sent")

	other := "11111111-0000-4000-8000-0000000000cc" // an agent that never has a transcript: its first stop sends the list once, not at every turn
	h.noteEventForLastMessage(other, "stop")
	assert.Equal(t, before+2, h.wsList.kickGen)
	h.noteEventForLastMessage(other, "stop")
	assert.Equal(t, before+2, h.wsList.kickGen, "the second stop sends nothing")
}
