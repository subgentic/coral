package routes

import (
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #18620: an Activity row for a welcome Dismiss names the item the write closed, the Getting started block when it is hidden, and nothing for a write that closed none.
func TestWelcomeDismissTitleNamesWhatTheWriteClosed(t *testing.T) {
	assert.Equal(t, "Read the Coral guide", welcomeDismissTitle("inbox_welcome_done", map[string]string{"inbox_welcome_done": "welcome,agent"}, map[string]string{"inbox_welcome_done": "welcome,agent,guide"}))
	assert.Equal(t, "Start your first agent, Make a team so agents can work together", welcomeDismissTitle("inbox_welcome_done", nil, map[string]string{"inbox_welcome_done": "agent, team"}))
	assert.Equal(t, "", welcomeDismissTitle("inbox_welcome_done", map[string]string{"inbox_welcome_done": "agent"}, map[string]string{"inbox_welcome_done": "agent"}), "nothing new: the old words stay")
	assert.Equal(t, "", welcomeDismissTitle("inbox_welcome_done", nil, map[string]string{"inbox_welcome_done": "not-an-item"}))
	assert.Equal(t, "Getting started", welcomeDismissTitle("inbox_welcome", nil, map[string]string{"inbox_welcome": "off"}))
	assert.Equal(t, "", welcomeDismissTitle("inbox_welcome", nil, map[string]string{"inbox_welcome": "on"}))
	assert.Equal(t, "", welcomeDismissTitle("goal_done_hidden", nil, map[string]string{"goal_done_hidden": "[]"}))
}

// The names are the Inbox's own: a title changed in welcome_items.js and not here would make the Activity row say something the Inbox never did.
func TestWelcomeTitlesAreTheInboxsOwn(t *testing.T) {
	src, err := os.ReadFile("../../../pkg/frontend/static/welcome_items.js")
	require.NoError(t, err)
	for id, title := range welcomeTitles {
		re := regexp.MustCompile(`(?m)^\s*` + id + `: \{ title: '` + regexp.QuoteMeta(title) + `'`)
		assert.True(t, re.Match(src), "welcome_items.js has no %s item titled %q", id, title)
	}
}
