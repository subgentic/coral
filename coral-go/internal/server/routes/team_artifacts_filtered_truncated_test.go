package routes

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16564 (QA Engineer 2 on #16541): the reply says whether the FILTERED list may be missing rows. truncated is the scan cap over a team's newest tasks before any filter; a filtered list of
// a few rows can still miss matches in older tasks, so filtered_truncated is true when a filter is on and the scan was cut; a list with no filter on, or a scan that was not cut, says false.
func TestTeamArtifactsSaysWhetherTheFilteredListWasCut(t *testing.T) {
	e := newTAEnv(t)
	for _, tc := range []struct {
		name      string
		query     url.Values
		truncated bool
		want      bool
	}{
		{"a search on a cut scan", url.Values{"q": {"plan"}}, true, true},
		{"a kind on a cut scan", url.Values{"kind": {"image"}}, true, true},
		{"waiting on a cut scan", url.Values{"waiting": {"1"}}, true, true},
		{"a search on a scan that was not cut", url.Values{"q": {"plan"}}, false, false},
		{"only a sort on a cut scan: no filter is on", url.Values{"sort": {"name"}}, true, false},
		{"only a limit and a sort on a cut scan", url.Values{"sort": {"newest"}, "limit": {"5"}}, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tq, err := parseTeamArtifactQuery(tc.query)
			require.NoError(t, err)
			require.NotNil(t, tq, "the query is a query")
			req := httptest.NewRequest(http.MethodGet, "/api/board/alpha/artifacts?"+tc.query.Encode(), nil)
			items, _, err := e.h.projectArtifactItems(req, "alpha", "")
			require.NoError(t, err)
			rec := httptest.NewRecorder()
			e.h.queryTeamArtifacts(rec, req, "alpha", items, tc.truncated, 50, 0, "", tq, e.h.bs.ArtifactsRevision("alpha"))
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var raw map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
			assert.Equal(t, tc.truncated, raw["truncated"], "truncated stays the scan's own word")
			assert.Equal(t, tc.want, raw["filtered_truncated"], "filtered_truncated")
		})
	}
}

// The cross-team list (the Inbox's) says it the same way. More teams than the list walks is a cut scan; with a filter on it is a cut filtered list, without one it is not (truncated says it).
func TestAllTeamArtifactsSaysWhetherTheFilteredListWasCut(t *testing.T) {
	t.Parallel()
	srv, h := allTeamArtifactsServer(t)
	for i := 0; i <= maxTeamArtifactTeams; i++ { // one more team than the list walks
		subscribeSession(t, h, fmt.Sprintf("team-%02d", i), "Alice", fmt.Sprintf("00000000-0000-4000-8000-%012d", i))
	}
	get := func(query string) map[string]any {
		resp, err := http.Get(srv.URL + "/api/team-artifacts" + query)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		require.Equal(t, http.StatusOK, resp.StatusCode, string(b))
		var raw map[string]any
		require.NoError(t, json.Unmarshal(b, &raw))
		return raw
	}
	filtered := get("?q=plan")
	assert.Equal(t, true, filtered["truncated"], "the walk was cut")
	assert.Equal(t, true, filtered["filtered_truncated"], "a filter on a cut walk")
	waiting := get("?waiting=1")
	assert.Equal(t, true, waiting["filtered_truncated"], "waiting is a filter")
	plain := get("?sort=name")
	assert.Equal(t, true, plain["truncated"])
	assert.Equal(t, false, plain["filtered_truncated"], "no filter is on: truncated alone says it")
}
