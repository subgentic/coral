package agent

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #15012: the chats list was flooded with rows titled "Chat rollou": Codex writes a rollout file for runs no person typed into (a sub-agent, a background run), and the list titled each by its file name.
// A rollout with no person-written turn is not a chat: it is left out of History, as a guardian's is. One with a typed message, or one Coral started (its marker), stays.
func TestCodexRolloutsWithNoPersonWrittenTurnAreNotChats(t *testing.T) {
	base := t.TempDir()
	day := filepath.Join(base, "2026", "11", "09")
	meta := func(id string) string {
		return `{"timestamp":"2026-11-09T10:00:00.000Z","type":"session_meta","payload":{"id":"` + id + `"}}`
	}
	injected := `{"timestamp":"2026-11-09T10:00:00.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd /x</environment_context>"}]}}`
	reply := `{"timestamp":"2026-11-09T10:00:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Done: nothing to report.","phase":"final_answer"}}`
	real := filepath.Join(day, "rollout-2026-11-09T10-00-00-019e90eb-a08a-7511-a410-000000015012.jsonl")
	writeLines(t, real, meta("019e90eb-a08a-7511-a410-000000015012"), injected,
		`{"timestamp":"2026-11-09T10:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"debug the dashboard feature","images":[]}}`, reply)
	var noUser []string
	for i, n := range []string{"a", "b", "c"} {
		p := filepath.Join(day, "rollout-2026-11-09T10-0"+string(rune('1'+i))+"-00-019e90eb-a08a-7511-a410-00000001501"+n+".jsonl")
		writeLines(t, p, meta("019e90eb-a08a-7511-a410-00000001501"+n), injected, reply)
		noUser = append(noUser, p)
	}
	started := filepath.Join(day, "rollout-2026-11-09T10-05-00-019e90eb-a08a-7511-a410-0000000150ff.jsonl")
	writeLines(t, started, meta("019e90eb-a08a-7511-a410-0000000150ff"),
		`{"timestamp":"2026-11-09T10:05:00.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"`+at.CoralSessionMarkerPrefix+` 11111111-2222-4333-8444-555555555555 <user_instructions>x</user_instructions>"}]}}`, reply)

	got, err := (&CodexAgent{}).ExtractSessions(base, nil)
	require.NoError(t, err)
	kept, excluded := map[string]bool{}, map[string]bool{}
	for _, s := range got {
		if s.Excluded {
			excluded[s.SourceFile] = true
		} else {
			kept[s.SourceFile] = true
		}
	}
	assert.True(t, kept[real], "the chat a person typed in stays")
	assert.True(t, kept[started], "an agent Coral started stays whatever its first turn was")
	for _, p := range noUser {
		assert.True(t, excluded[p], "%s: no person-written turn: not a chat", filepath.Base(p))
		assert.False(t, kept[p])
	}
	assert.Len(t, kept, 2)
}
