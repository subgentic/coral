package routes

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13172 (slice 1c): waiting=1|0 on the artifacts list: the files that wait for the Operator by the server's own rule (needsYouFile, the rule the Hub's Needs you count uses: for review and not opened, or news in a decided file's thread; never
// saved, ignored or superseded) and whose stored file is there, or the ones that do not. With muted=0 and versions=newest it is the count the Needs you badge shows, from one read with limit=1.
func TestWaitingIsTheServersNeedsYouRuleOnTheList(t *testing.T) {
	e := newInboxEnv(t)
	count := func(q string) int {
		t.Helper()
		code, total, _ := e.listMuted(t, q, true)
		require.Equal(t, 200, code)
		return total
	}
	assert.Equal(t, 1, count("&waiting=1"), "for review and not opened: waits")
	assert.Equal(t, 0, count("&waiting=0"))
	e.tag(t, `["for review","read"]`)
	assert.Equal(t, 0, count("&waiting=1"), "opened: no longer waits (still in the list, as before)")
	assert.Equal(t, 1, count("&waiting=0"))
	assert.Equal(t, 1, count(""), "no waiting parameter: today's list, the opened file still in it")
	e.tag(t, `["for review","saved"]`)
	assert.Equal(t, 0, count("&waiting=1"), "saved: never waits")
	e.tag(t, `["for review","ignored"]`)
	assert.Equal(t, 0, count("&waiting=1"), "ignored: never waits")
	e.tag(t, `["for review","changes requested"]`)
	assert.Equal(t, 0, count("&waiting=1"), "changes requested with no news: the agent's turn")
	e.tag(t, `["for review"]`)
	assert.Equal(t, 1, count("&waiting=1&muted=0"), "back to waiting; with muted=0 it is the badge's count")
	e.kind(t, "digest")
	e.settings["inbox_kind_digest"] = "false"
	assert.Equal(t, 1, count("&waiting=1"), "a muted file still waits: muted is its own filter")
	assert.Equal(t, 0, count("&waiting=1&muted=0"), "and the badge's count leaves it out")
}

func TestAWaitingFileWhoseStoredFileIsGoneDoesNotWait(t *testing.T) {
	e := newInboxEnv(t)
	_, total, _ := e.listMuted(t, "&waiting=1", true)
	require.Equal(t, 1, total)
	require.NoError(t, os.Remove(filepath.Join(e.h.artifactObjectDir(), e.id)))
	_, total, _ = e.listMuted(t, "&waiting=1", true)
	assert.Equal(t, 0, total, "the Operator cannot open it: it is not counted (Needs you's own rule: available)")
	_, total, _ = e.listMuted(t, "", true)
	assert.Equal(t, 1, total, "it is still in the list")
}

func TestWaitingIsAClosedFlagAndPartOfTheCursor(t *testing.T) {
	e := newInboxEnv(t)
	for _, q := range []string{"&waiting=2", "&waiting=", "&waiting=yes", "&waiting=1&waiting=0"} {
		code, _, _ := e.listMuted(t, q, true)
		assert.Equal(t, 400, code, q)
	}
	finger := func(v string) string {
		qq, err := parseTeamArtifactQuery(url.Values{"waiting": {v}})
		require.NoError(t, err)
		return qq.finger
	}
	assert.NotEqual(t, finger("1"), finger("0"), "a cursor made for one value is refused for the other")
}
