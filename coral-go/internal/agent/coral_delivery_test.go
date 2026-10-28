package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10046: a turn Coral typed into an agent (the unread-messages nudge, a task notice, the health check, a stop-hook block) is not what a person asked for. The transcript records it as a user
// turn, and a session's first prompt (and the goal made from its requests) took the nudge for the request.
func TestIsCoralDeliveryKnowsWhatCoralTypesIntoAnAgent(t *testing.T) {
	// The cases are one file the dashboard's isCoralNudge is tested against too (tests/frontend/coral_notice_fixture.test.mjs), so the two lists of patterns cannot drift (#10125).
	raw, err := os.ReadFile(filepath.Join("testdata", "coral_deliveries.json"))
	require.NoError(t, err)
	var cases struct {
		Notices    []string `json:"notices"`
		NotNotices []string `json:"not_notices"`
	}
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.NotEmpty(t, cases.Notices)
	require.NotEmpty(t, cases.NotNotices)
	for _, text := range cases.Notices {
		assert.True(t, IsCoralDelivery(text), text)
	}
	for _, text := range cases.NotNotices {
		assert.False(t, IsCoralDelivery(text), text)
	}
}
