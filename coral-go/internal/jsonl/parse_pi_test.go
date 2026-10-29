package jsonl

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
