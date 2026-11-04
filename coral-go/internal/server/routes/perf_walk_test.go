package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// #13522 (goal #215): the dashboard's Needs you reads a team's for-review files a page of 200 at a time by the cursor, so a board of 20,000 files is 100 requests in a row. Each request used to
// rebuild and sort the whole list again (about 125 ms a page on the mini: 14 s for the walk). The goal is an early Needs you under 3 s, so the whole cold walk of the same seed (20,000
// uploads, all for review) has to stay under it. CORAL_PERF_BUDGET_SCALE scales the ceiling (0.001 shows the test failing). Skipped with -short.
const goalNeedsYouWalkMs = 3000

func bigBoardWalkRig(t *testing.T, tagged bool) (*BoardHandler, *httptest.Server, []string) {
	t.Helper()
	_, h := setupBoardTestServer(t)
	coralDir := t.TempDir()
	h.SetTaskArtifactWriter(coralDir, nil)
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	ids := seedBigUploads(t, coralDir, 20000)
	if tagged {
		for _, id := range ids {
			require.NoError(t, h.bs.SetArtifactTags(context.Background(), "alpha", id, []string{"for review"}))
		}
	}
	time.Sleep(uploadDirSettle + 2*time.Second) // the upload directory cache trusts a folder only once it has been unchanged for a while
	r := chi.NewRouter()
	r.Get("/api/board/{project}/artifacts", func(w http.ResponseWriter, rq *http.Request) { h.ListTeamArtifacts(w, asPerson(rq)) })
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return h, srv, ids
}

// walkForReview reads every page of the for-review list the way the dashboard does (a page of 200, the cursor of the page before) and returns how many files and pages it read.
func walkForReview(t *testing.T, srv *httptest.Server) (files, pages int) {
	t.Helper()
	cursor := ""
	for pages < 1000 {
		u := srv.URL + "/api/board/alpha/artifacts?tag=for%20review&limit=200"
		if cursor != "" {
			u += "&cursor=" + url.QueryEscape(cursor)
		}
		resp, err := http.Get(u)
		require.NoError(t, err)
		var body struct {
			Artifacts  []json.RawMessage `json:"artifacts"`
			HasMore    bool              `json:"has_more"`
			NextCursor string            `json:"next_cursor"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		pages++
		files += len(body.Artifacts)
		if !body.HasMore || body.NextCursor == "" {
			return
		}
		cursor = body.NextCursor
	}
	t.Fatal("the walk did not end")
	return
}

func TestNeedsYouWalkOfABigBoardIsUnderTheGoal(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds 20,000 uploads: skipped with -short")
	}
	_, srv, _ := bigBoardWalkRig(t, true)
	scale := 1.0
	if v := os.Getenv("CORAL_PERF_BUDGET_SCALE"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			scale = f
		}
	}
	t0 := time.Now()
	files, pages := walkForReview(t, srv)
	elapsed := time.Since(t0)
	t.Logf("PERF the cold walk of the for-review list: %d files in %d pages, %s (goal %s)", files, pages, elapsed.Round(time.Millisecond), time.Duration(float64(goalNeedsYouWalkMs)*scale)*time.Millisecond)
	require.Equal(t, 20000, files, "every file for review is in the walk")
	if elapsed > time.Duration(float64(goalNeedsYouWalkMs)*scale)*time.Millisecond {
		t.Errorf("the cold walk of 20,000 for-review files took %s, over the goal's %d ms (#13522)", elapsed.Round(time.Millisecond), int(float64(goalNeedsYouWalkMs)*scale))
	}
	_ = fmt.Sprint
}
