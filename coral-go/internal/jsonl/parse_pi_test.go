package jsonl

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const piTestSession = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"

// piFixtureHome copies the scrubbed Pi 1.4.0 session (testdata/pi-1.4.0/session.jsonl: a real session, every text replaced, structure kept) to where Coral's Pi launch puts it,
// <data dir>/pi-sessions/<session id>/<timestamp>_<pi id>.jsonl, and points the reader at that data dir.
func piFixtureHome(t *testing.T, sessionID string, content []byte) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dir)
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(dir, "no-pi-home"))
	sessionDir := filepath.Join(dir, "pi-sessions", sessionID)
	require.NoError(t, os.MkdirAll(sessionDir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(sessionDir, "2026-10-29T19-44-35-010Z_01a18931-58c2-74fc-8a74-bed622970705.jsonl"), content, 0o600))
}

func readPi(t *testing.T, sessionID string) []map[string]any {
	t.Helper()
	msgs, _ := NewSessionReader().ReadAllMessagesContext(context.Background(), sessionID, "/work/pi-project", "pi")
	return msgs
}

// #11088: a Pi agent's turns reach the chat. Before this the reader had no Pi parser, so the chat of a Pi agent stayed empty.
func TestPiSessionRendersItsTurnsInTheChat(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join("testdata", "pi-1.4.0", "session.jsonl"))
	require.NoError(t, err)
	piFixtureHome(t, piTestSession, fixture)

	msgs := readPi(t, piTestSession)
	require.NotEmpty(t, msgs, "the Pi session is read")

	var users, assistants, errs []string
	toolUses, toolResults := 0, 0
	for _, m := range msgs {
		text, _ := m["content"].(string)
		switch m["type"] {
		case "user":
			users = append(users, text)
		case "assistant":
			if s, _ := m["text"].(string); s != "" {
				if m["is_error"] == true {
					errs = append(errs, s)
				} else {
					assistants = append(assistants, s)
				}
			}
			if tu, ok := m["tool_uses"].([]map[string]any); ok {
				toolUses += len(tu)
			}
		case "tool_result":
			toolResults++
		}
	}
	assert.Equal(t, []string{"FIXTURE-USER-1 question", "FIXTURE-USER-2 question", "FIXTURE-USER-3 question", "FIXTURE-USER-4 question"}, users, "every user turn, in order")
	assert.Equal(t, []string{"FIXTURE-ASSISTANT-1 answer", "FIXTURE-ASSISTANT-2 answer", "FIXTURE-ASSISTANT-3 answer"}, assistants, "every assistant reply")
	require.Len(t, errs, 1, "the turn Pi ended with an error is shown, flagged")
	assert.Contains(t, errs[0], "Error: 400")
	assert.Contains(t, errs[0], "invalid_request_error")
	assert.Equal(t, 15, toolUses, "the 15 tool calls")
	assert.Equal(t, 15, toolResults, "and their 15 results")

	all := ""
	for _, m := range msgs {
		all += anyText(m) + "\n"
	}
	assert.NotContains(t, all, "FIXTURE-SYSTEM", "the system prompt entry (the whole prompt and tool list) is not a turn")
}

func anyText(m map[string]any) string {
	var b strings.Builder
	for _, k := range []string{"content", "text"} {
		if s, ok := m[k].(string); ok {
			b.WriteString(s)
		}
	}
	return b.String()
}

func TestPiToolCallsAndResultsPairUp(t *testing.T) {
	fixture, err := os.ReadFile(filepath.Join("testdata", "pi-1.4.0", "session.jsonl"))
	require.NoError(t, err)
	piFixtureHome(t, piTestSession, fixture)
	msgs := readPi(t, piTestSession)

	calls := map[string]map[string]any{}
	for _, m := range msgs {
		if tus, ok := m["tool_uses"].([]map[string]any); ok {
			for _, tu := range tus {
				id, _ := tu["tool_use_id"].(string)
				require.NotEmpty(t, id)
				calls[id] = tu
			}
		}
	}
	require.Len(t, calls, 15)
	for _, m := range msgs {
		if m["type"] != "tool_result" {
			continue
		}
		id, _ := m["tool_use_id"].(string)
		call, ok := calls[id]
		require.True(t, ok, "every result belongs to a call: %s", id)
		assert.Equal(t, call["name"], m["tool_name"])
		assert.Contains(t, m["content"], "FIXTURE-RESULT-")
	}
	var bash, write map[string]any
	for _, c := range calls {
		switch c["name"] {
		case "bash":
			bash = c
		case "write":
			write = c
		}
	}
	require.NotNil(t, bash)
	assert.Contains(t, bash["command"], "echo FIXTURE-CMD-", "a bash call shows its command")
	require.NotNil(t, write)
	assert.Contains(t, write["input_summary"], "/work/FIXTURE-", "a write call shows its file")
	assert.Contains(t, write["write_content"], "FIXTURE-WRITE-")
}

// #11091 (Security's SHOULDs on #11088): the session's folder is only ever its own real folder. A pi-sessions/<id> that is a link (the agent can write in pi-sessions) is refused, not followed to
// another folder's transcript.
func TestPiSessionFolderThatIsALinkIsRefused(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dir)
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(dir, "no-pi-home"))
	elsewhere := filepath.Join(dir, "elsewhere")
	require.NoError(t, os.MkdirAll(elsewhere, 0o700))
	fixture, err := os.ReadFile(filepath.Join("testdata", "pi-1.4.0", "session.jsonl"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(elsewhere, "2026-10-29T19-44-35-010Z_01a18931-58c2-74fc-8a74-bed622970705.jsonl"), fixture, 0o600))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "pi-sessions"), 0o700))
	if err := os.Symlink(elsewhere, filepath.Join(dir, "pi-sessions", piTestSession)); err != nil {
		t.Skip("no symlinks here: " + err.Error())
	}
	assert.Equal(t, "", resolvePiTranscript(piTestSession), "a linked session folder is not the session's own")
	assert.Empty(t, readPi(t, piTestSession), "and nothing of it reaches the chat")

	// pi-sessions itself as a link to a folder that holds a real session folder.
	require.NoError(t, os.Remove(filepath.Join(dir, "pi-sessions", piTestSession)))
	require.NoError(t, os.Remove(filepath.Join(dir, "pi-sessions")))
	real := filepath.Join(dir, "real-sessions")
	require.NoError(t, os.MkdirAll(filepath.Join(real, piTestSession), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(real, piTestSession, "a.jsonl"), fixture, 0o600))
	require.NoError(t, os.Symlink(real, filepath.Join(dir, "pi-sessions")))
	assert.Equal(t, "", resolvePiTranscript(piTestSession), "pi-sessions as a link is refused too")
}

// The fallback walk of Pi's own sessions folder is not repeated on every poll for a session that has none there: a miss is remembered for a few seconds.
func TestPiFallbackWalkMissIsRemembered(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dir)
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(dir, "pi-home"))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "pi-home", "sessions", "--x--"), 0o700))
	walks := 0
	piWalkHook = func() { walks++ }
	now := time.Unix(1_800_000_000, 0)
	piWalkNow = func() time.Time { return now }
	t.Cleanup(func() { piWalkHook, piWalkNow = nil, time.Now })
	const sid = "11111111-2222-4333-8444-555555555555"
	assert.Equal(t, "", resolvePiTranscript(sid))
	assert.Equal(t, "", resolvePiTranscript(sid))
	assert.Equal(t, 1, walks, "the second look within the window does not walk again")
	now = now.Add(piWalkMissTTL + time.Second)
	assert.Equal(t, "", resolvePiTranscript(sid))
	assert.Equal(t, 2, walks, "after the window it looks again")
	// A file that appears is found as soon as the window has passed.
	f := filepath.Join(dir, "pi-home", "sessions", "--x--", "2026-10-29T19-44-35-010Z_"+sid+".jsonl")
	require.NoError(t, os.WriteFile(f, []byte(`{"type":"session"}`+"\n"), 0o600))
	now = now.Add(piWalkMissTTL + time.Second)
	assert.Equal(t, f, resolvePiTranscript(sid))
}

// One message's text and one command are cut at about 1 MB, as a write's content is cut at 10 KB: a transcript line the agent made is not a way to make the chat huge.
func TestPiTextAndCommandAreCapped(t *testing.T) {
	big := strings.Repeat("x", 3<<20)
	names := map[string]string{}
	user := parsePiEntry(map[string]any{"type": "message", "message": map[string]any{"role": "user", "content": big}}, names)
	require.Len(t, user, 1)
	assert.LessOrEqual(t, len(user[0]["content"].(string)), piMaxText+64)
	asst := parsePiEntry(map[string]any{"type": "message", "message": map[string]any{"role": "assistant", "content": []any{
		map[string]any{"type": "text", "text": big},
		map[string]any{"type": "toolCall", "id": "c1", "name": "bash", "arguments": map[string]any{"command": big}},
	}}}, names)
	require.Len(t, asst, 1)
	assert.LessOrEqual(t, len(asst[0]["text"].(string)), piMaxText+64)
	tu := asst[0]["tool_uses"].([]map[string]any)
	assert.LessOrEqual(t, len(tu[0]["command"].(string)), piMaxText+64)
	assert.LessOrEqual(t, len(tu[0]["input_summary"].(string)), 1000)
}
