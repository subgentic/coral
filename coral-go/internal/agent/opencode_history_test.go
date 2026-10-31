package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAnOpencodeSessionsHistoryRowIsBuiltLikeEveryOthers(t *testing.T) {
	secret := "ghp_aB3dE5gH7jaB3dE5gH7jaB3dE5gH7jkLmNoP"
	row := IndexOpencodeSession("sid-1", []OpencodeHistoryMessage{
		{Role: "user", Text: "You have 2 unread messages on the message board. Run coral-board read.", At: "1761862800000"},
		{Role: "user", Text: "use token " + secret + " to push", At: "1761862860000"},
		{Role: "assistant", Text: "", At: "1761862870000"},
		{Role: "tool", Text: "ls output", At: "1761862880000"},
		{Role: "assistant", Text: "pushed", At: "2026-10-30T22:25:00Z"},
	}, 1761862900)
	require.NotNil(t, row)
	assert.Equal(t, "opencode", row.SourceType)
	assert.Equal(t, "opencode://sid-1", row.SourceFile)
	assert.Equal(t, 3, row.MessageCount, "text of the person and the agent only: no empty turn, no tool row")
	assert.NotContains(t, row.FirstUserMessage, secret, "redacted before it is clipped")
	assert.NotContains(t, row.DisplaySummary, secret)
	assert.Contains(t, row.FirstUserMessage, "use token", "and Coral's own notice is not the first message")
	require.NotNil(t, row.FirstTimestamp)
	assert.Equal(t, "2025-10-30T22:20:00Z", *row.FirstTimestamp, "epoch milliseconds become RFC 3339")
	assert.Contains(t, row.FTSBody, "pushed")
	assert.Equal(t, HistoryIndexVersion, row.IndexVersion)
	assert.Equal(t, 1761862900.0, row.FileMtime)
	assert.Empty(t, IndexOpencodeSession("x", nil, 1).FTSBody)
}
