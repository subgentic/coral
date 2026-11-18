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
		Mixed      []struct {
			Text  string `json:"text"`
			Typed string `json:"typed"`
		} `json:"mixed"`
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
	require.NotEmpty(t, cases.Mixed)
	for _, c := range cases.Mixed { // a nudge with a person's lines after it (#19534): theirs, and the dashboard reads it the same way
		assert.False(t, IsCoralDelivery(c.Text), c.Text)
		assert.Equal(t, c.Typed, PersonText(c.Text))
	}
}

// #19534: the board nudge and a person's typed lines are one user turn when the agent was busy; the turn is the person's, with the nudge line left off. A lone nudge, and a nudge with nothing after it, are
// still Coral's.
func TestANudgeWithTypedLinesAfterItIsThePersonsTurn(t *testing.T) {
	nudge := "You have unread messages on the message board. Run 'coral-board read' to see them."
	mixed := nudge + "\n1. lets just finish the work in progress there is no rush\n2. close"
	assert.False(t, IsCoralDelivery(mixed))
	n, typed := SplitNudge(mixed)
	assert.Equal(t, nudge, n)
	assert.Equal(t, "1. lets just finish the work in progress there is no rush\n2. close", typed)
	assert.Equal(t, typed, PersonText(mixed))
	assert.Equal(t, typed, PersonText("<pasted_content id=\"1\">"+mixed+"</pasted_content id=\"1\">"))
	text, ok := typedText(mixed)
	assert.True(t, ok)
	assert.Equal(t, typed, text, "the first message a history search lists")

	for _, alone := range []string{nudge, nudge + "\n", "You have 2 unread messages on the message board.", "[Task #7 (high) available] build it\nmore"} {
		assert.True(t, IsCoralDelivery(alone), alone)
		assert.Equal(t, alone, PersonText(alone))
	}
}
