package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11092 (Pi parity rows 3 and 17): the History indexer reads Pi 1.4.0's real session file, a scrubbed fixture of one: every entry is {"type":"message","message":{"role","content":[blocks]}}, with
// the header {"type":"session","id"} first. A Coral-launched Pi keeps its sessions in <data dir>/pi-sessions/<Coral session id>/, and that folder name is the id the chat, the live row and
// the token poller know the session by.
const piCoralSessionID = "11111111-2222-4333-8444-555555555555"

func piFixtureBase(t *testing.T) (base, file string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "jsonl", "testdata", "pi-1.4.0", "session.jsonl"))
	require.NoError(t, err)
	base = filepath.Join(t.TempDir(), "pi-sessions")
	dir := filepath.Join(base, piCoralSessionID)
	require.NoError(t, os.MkdirAll(dir, 0o700))
	file = filepath.Join(dir, "2026-10-29T19-44-35-010Z_00000000-0000-4000-8000-0000000000f1.jsonl")
	require.NoError(t, os.WriteFile(file, data, 0o600))
	return base, file
}

func TestPiIndexerReadsTheRealSessionShape(t *testing.T) {
	base, file := piFixtureBase(t)
	s, err := parsePiSession(file, 1)
	require.NoError(t, err)
	require.NotNil(t, s)
	assert.Equal(t, piCoralSessionID, s.SessionID, "the id is the Coral session folder's name (what the chat and the live row use), not Pi's header id")
	assert.Equal(t, "FIXTURE-USER-1 question", s.FirstUserMessage)
	assert.Equal(t, "FIXTURE-USER-1 question", s.DisplaySummary)
	assert.Equal(t, 4+3, s.MessageCount, "four user turns and the three assistant answers with text; tool calls, tool results and the system entry are not messages")
	require.NotNil(t, s.FirstTimestamp)
	assert.Equal(t, "2026-10-29T19:44:35.059Z", *s.FirstTimestamp)
	for _, word := range []string{"FIXTURE-USER-3 question", "FIXTURE-ASSISTANT-2 answer"} {
		assert.Contains(t, s.FTSBody, word, "search finds what either side said")
	}
	for _, not := range []string{"FIXTURE-THINKING-1", "FIXTURE-SYSTEM-preamble", "FIXTURE-CMD-1"} {
		assert.NotContains(t, s.FTSBody, not, "thinking, the system prompt and tool arguments are not searchable chat text")
	}

	sessions, err := (&PiAgent{}).ExtractSessions(base, nil)
	require.NoError(t, err)
	require.Len(t, sessions, 1)
	assert.Equal(t, piCoralSessionID, sessions[0].SessionID)
}

func TestPiHistoryScansTheCoralSessionFolder(t *testing.T) {
	data := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", data)
	assert.Equal(t, filepath.Join(data, "pi-sessions"), (&PiAgent{}).HistoryBasePath(), "Pi chats launched by Coral live under the data dir, not ~/.pi/agent")
}
