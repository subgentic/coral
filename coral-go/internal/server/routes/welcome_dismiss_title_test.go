package routes

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store/storetest"
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

// #17475: unknown ids are not a restore merely because they have no welcome title.
// The approved #19125 behavior requires a removed id and no newly named item.
func TestWelcomeDismissalBoundaryClassification(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "dismiss.db"))
	require.NoError(t, err)
	defer db.Close()
	h := NewSystemHandler(db, nil)
	for _, tc := range []struct {
		name, before, after, title string
		restored                   bool
	}{
		{"known addition", "", "agent", "Start your first agent", false},
		{"unknown addition", "", "future-item", "", false},
		{"unknown unchanged", "future-item", "future-item", "", false},
		{"empty unchanged", "", "", "", false},
		{"unknown removal", "future-item", "", "", true},
		{"known removal", "agent", "", "", true},
		{"replacement adds a named item", "agent", "guide", "Read the Coral guide", false},
		{"closed goal id has no welcome title", "", "goalclosed:team:7", "", false},
		{"file id has no welcome title", "", "file:abc", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, h.ss.SaveSettings(t.Context(), map[string]string{"inbox_welcome_dismissed": tc.before}))
			title, restored := h.welcomeDismissal(t.Context(), map[string]string{"inbox_welcome_dismissed": tc.after})
			assert.Equal(t, tc.title, title)
			assert.Equal(t, tc.restored, restored)
		})
	}
	for _, key := range []string{"goal_done_hidden", "goalclosed:team:7", "artifact_review"} {
		assert.Empty(t, welcomeDismissTitle(key, nil, map[string]string{key: "agent"}), "welcome naming does not claim non-welcome actions: %s", key)
	}
}
