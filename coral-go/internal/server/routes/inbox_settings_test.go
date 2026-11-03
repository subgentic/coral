package routes

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #12144 (Security's rule): Settings > Inbox values are parsed on the server: the switches are booleans, the included teams the word all or a list of plain team ids, the time HH:MM; a refused request saves
// nothing.
func putInbox(t *testing.T, body string) (int, map[string]string) {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "c.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewSystemHandler(db, nil)
	r := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.PutSettings(rec, r)
	s, _ := store.NewSessionStore(db).GetSettings(t.Context())
	return rec.Code, s
}

func TestInboxSettingsAreParsedOnTheServer(t *testing.T) {
	code, s := putInbox(t, `{"inbox_kind_release":false,"inbox_kind_done":"false","inbox_kind_file":true,"inbox_included_teams":"[\"alpha\",\"beta\",\"alpha\"]","inbox_digest_time":"07:30"}`)
	require.Equal(t, 200, code)
	assert.Equal(t, "false", s["inbox_kind_release"])
	assert.Equal(t, "false", s["inbox_kind_done"])
	assert.Equal(t, "true", s["inbox_kind_file"])
	assert.Equal(t, `["alpha","beta"]`, s["inbox_included_teams"], "stored once each, as a list")
	assert.Equal(t, "07:30", s["inbox_digest_time"])
	p := readInboxPrefs(s)
	assert.True(t, p.muted("alpha", "release"))
	assert.False(t, p.muted("alpha", "file"))
	assert.True(t, p.muted("gamma", "file"), "a team not on the list")
	code, s = putInbox(t, `{"inbox_included_teams":"all"}`)
	require.Equal(t, 200, code)
	assert.Equal(t, "all", s["inbox_included_teams"])
	code, s = putInbox(t, `{"inbox_included_teams":""}`)
	require.Equal(t, 200, code)
	assert.Equal(t, "all", s["inbox_included_teams"], "empty is all")
}

func TestInboxSettingsRefuseWhatIsNotTheRightShapeAndSaveNothing(t *testing.T) {
	for name, body := range map[string]string{
		"a switch that is not a boolean":   `{"inbox_kind_release":"maybe","theme":"dark"}`,
		"teams that are not a list":        `{"inbox_included_teams":"alpha","theme":"dark"}`,
		"teams with an object":             `{"inbox_included_teams":"{\"a\":1}","theme":"dark"}`,
		"a team id with a control":         `{"inbox_included_teams":"[\"al\\u0000pha\"]","theme":"dark"}`,
		"a team id with a reordering mark": `{"inbox_included_teams":"[\"al\\u202epha\"]","theme":"dark"}`,
		"a team id with a zero-width mark": `{"inbox_included_teams":"[\"al\\u200bpha\"]","theme":"dark"}`,
		"an empty team id":                 `{"inbox_included_teams":"[\"\"]","theme":"dark"}`,
		"a team id of 200 characters":      `{"inbox_included_teams":"[\"` + strings.Repeat("a", 200) + `\"]","theme":"dark"}`,
		"time with seconds":                `{"inbox_digest_time":"09:00:00","theme":"dark"}`,
		"time past 24 hours":               `{"inbox_digest_time":"24:00","theme":"dark"}`,
		"time of minutes past 59":          `{"inbox_digest_time":"09:60","theme":"dark"}`,
		"a time in words":                  `{"inbox_digest_time":"nine","theme":"dark"}`,
		"a time as a number":               `{"inbox_digest_time":900,"theme":"dark"}`,
	} {
		code, s := putInbox(t, body)
		assert.Equal(t, 400, code, name)
		assert.Empty(t, s["theme"], "%s: nothing in a refused request is saved", name)
	}
}

// The defaults when nothing is saved: every kind on, every team included, nothing muted; an unreadable value is the default, never a mute.
func TestInboxDefaultsMuteNothing(t *testing.T) {
	p := readInboxPrefs(nil)
	for _, k := range []string{"file", "done", "release", "decided", "digest"} {
		assert.False(t, p.muted("any-team", k), k)
	}
	p = readInboxPrefs(map[string]string{"inbox_kind_release": "garbage", "inbox_included_teams": "{{{"})
	assert.False(t, p.muted("t", "release"), "an unreadable switch is on")
	assert.False(t, p.muted("t", "file"), "an unreadable team list includes every team")
}
