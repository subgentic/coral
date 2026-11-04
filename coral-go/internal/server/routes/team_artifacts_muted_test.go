package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13172 (slice 1b): muted=1|0 on the artifacts list: the files the Operator's inbox settings mute (#12144), or the ones they do not, before the page is cut. Only the Operator's own read marks a row muted; for any other caller no row is.
func (e *inboxEnv) listMuted(t *testing.T, query string, person bool) (int, int, []map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/board/alpha/artifacts?tag=for%20review"+query, nil)
	if person {
		req = asPerson(req)
	}
	req = withProject(req, "alpha")
	w := httptest.NewRecorder()
	e.h.ListTeamArtifacts(w, req)
	var out struct {
		Total     int              `json:"total"`
		Artifacts []map[string]any `json:"artifacts"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out.Total, out.Artifacts
}

func TestMutedFiltersTheListTheWayTheRowsAreMarked(t *testing.T) {
	e := newInboxEnv(t)
	e.kind(t, "digest")
	code, total, rows := e.listMuted(t, "&muted=0", true)
	require.Equal(t, 200, code)
	assert.Equal(t, 1, total, "kind on by default: not muted")
	require.Len(t, rows, 1)
	_, total, rows = e.listMuted(t, "&muted=1", true)
	assert.Equal(t, 0, total, "and not in the muted list")
	assert.Empty(t, rows)

	e.settings["inbox_kind_digest"] = "false"
	_, total, rows = e.listMuted(t, "&muted=0", true)
	assert.Equal(t, 0, total, "switched off: out of muted=0 (the badge and the list leave it out)")
	assert.Empty(t, rows)
	_, total, rows = e.listMuted(t, "&muted=1", true)
	assert.Equal(t, 1, total, "and in muted=1, with the total")
	require.Len(t, rows, 1)
	assert.Equal(t, true, rows[0]["muted"], "the row says so as it always did")
	_, total, _ = e.listMuted(t, "", true)
	assert.Equal(t, 1, total, "no muted parameter: today's list, the muted file still in it")
}

func TestMutedTellsNoOneButTheOperatorWhatIsMuted(t *testing.T) {
	e := newInboxEnv(t)
	e.kind(t, "digest")
	e.settings["inbox_kind_digest"] = "false"
	_, total, rows := e.listMuted(t, "&muted=1", false)
	assert.Equal(t, 0, total, "a reader who is not the Operator is never told a row is muted: muted=1 is empty")
	assert.Empty(t, rows)
	_, total, rows = e.listMuted(t, "&muted=0", false)
	assert.Equal(t, 1, total, "and muted=0 is the whole list they may read")
	require.Len(t, rows, 1)
	assert.Nil(t, rows[0]["muted"], "with no muted mark on the row")
}

func TestMutedIsAClosedFlagAndPartOfTheCursor(t *testing.T) {
	e := newInboxEnv(t)
	for _, q := range []string{"&muted=2", "&muted=", "&muted=true", "&muted=1&muted=0"} {
		code, _, _ := e.listMuted(t, q, true)
		assert.Equal(t, 400, code, q)
	}
	finger := func(v string) string {
		qq, err := parseTeamArtifactQuery(url.Values{"muted": {v}})
		require.NoError(t, err)
		return qq.finger
	}
	assert.NotEqual(t, finger("1"), finger("0"), "a cursor made for one value is refused for the other")
}
