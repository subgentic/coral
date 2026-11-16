package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// #18580: the dashboard's first load reads, on a big board, the cross-team files list (limit=1 for the count, the for-review facets list) and needs-you?kind=skill. This times each of them cold and warm
// on the 20,000-upload rig of the walk test (all for review), so a change to one shows in a number. PERF lines are logged; skipped with -short.
func TestFirstLoadReadsOfABigBoardAreTimed(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds 20,000 uploads: skipped with -short")
	}
	h, _, _ := bigBoardWalkRig(t, true)
	r := chi.NewRouter()
	r.Get("/api/team-artifacts", func(w http.ResponseWriter, rq *http.Request) { h.ListAllTeamArtifacts(w, asPerson(rq)) })
	r.Get("/api/needs-you", func(w http.ResponseWriter, rq *http.Request) { h.NeedsYou(w, asPerson(rq)) })
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	for _, c := range []struct{ name, path string }{
		{"team-artifacts limit=1 newest", "/api/team-artifacts?limit=1&versions=newest&offset=0"},
		{"team-artifacts for review facets", "/api/team-artifacts?tag=for+review&versions=newest&starred_first=true&facets=team,by&limit=50"},
		{"needs-you kind=skill", "/api/needs-you?kind=skill"},
		{"needs-you", "/api/needs-you"},
	} {
		for _, pass := range []string{"cold", "warm"} {
			t0 := time.Now()
			resp, err := http.Get(srv.URL + c.path)
			require.NoError(t, err)
			n := 0
			buf := make([]byte, 32<<10)
			for {
				m, e := resp.Body.Read(buf)
				n += m
				if e != nil {
					break
				}
			}
			resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode, c.name)
			t.Logf("PERF %-34s %s %8s %6d bytes", c.name, pass, time.Since(t0).Round(time.Millisecond), n)
		}
	}
}
