package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// #13522 (goal #215): the dashboard's Needs you reads a team's for-review files a page of 200 at a time by the cursor, so a board of 20,000 files is 100 requests in a row. Each request used to
// rebuild and sort the whole list again (about 125 ms a page on the mini: 14 s for the walk). The goal is an early Needs you under 3 s, so the whole cold walk of the same seed (20,000
// uploads, all for review) has to stay under it. CORAL_PERF_BUDGET_SCALE scales the ceiling (0.001 shows the test failing). Skipped with -short.
// The goal is 3 s; this in-process ceiling is 4 s so a loaded machine (other agents' go tests) does not fail the gate: 14 s before #13522, 1.4 to 2.6 s after. The browser suite (big_board_budget) holds the 3 s.
// A CI runner (the env var CI is set) is slower than the Mac and the mini: trial-250's gate measured 4.12 s there. So CI has its own ceiling of 8 s: still under the 14 s the cache-less code took
// on the fastest machine (a runner would take longer), so the old code still fails, and a run that is merely slow does not.
// walkAllocBoundMB bounds what the in-process walk allocates (client and server together). Measured on the mini (#13614): 554 MB with the fast path (the same twice), 25,064 MB when a page copies the matching rows of the whole list. 2,000 MB is 3.6 times the first and a twelfth of the second, so losing the fast path fails here on any machine, whatever its clock.
const walkAllocBoundMB = 2000

const (
	goalNeedsYouWalkMs   = 4000
	goalNeedsYouWalkCIMs = 8000
	// The CPU the walk may use on a developer's machine (#16035). The wall clock is the machine's as much as the code's: a box with four pinned cores or other agents' go tests took 5.6 and 6.1 s for a walk that
	// takes 1.6 s alone (epoch), and the best of three was no help. The walk's CPU time moves little with load (3.05 s alone, 3.55 s beside eight busy loops on the Mac). 7 s is twice what the walk uses
	// and the cache-less code (every page builds the list: 14 s on the fastest machine) is far over it.
	goalNeedsYouWalkCPUMs = 7000
)

// needsYouWalkCeilingMs is the ceiling for this machine: the CI one when CI is set.
func needsYouWalkCeilingMs() int {
	if os.Getenv("CI") != "" {
		return goalNeedsYouWalkCIMs
	}
	return goalNeedsYouWalkMs
}

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

// fastestWithin runs measure up to n times and returns the fastest duration it saw; a run within the budget ends it, so an unloaded machine takes one.
func fastestWithin(n int, budget time.Duration, measure func(attempt int) time.Duration) time.Duration {
	var best time.Duration
	for i := 0; i < n; i++ {
		d := measure(i)
		if i == 0 || d < best {
			best = d
		}
		if best <= budget {
			break
		}
	}
	return best
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
	if raceEnabled {
		t.Skip("a time budget means nothing under the race detector (about 10 to 20 times slower); the normal run keeps it (#14280)")
	}
	scale := 1.0
	if v := os.Getenv("CORAL_PERF_BUDGET_SCALE"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			scale = f
		}
	}
	ceiling := time.Duration(float64(needsYouWalkCeilingMs())*scale) * time.Millisecond
	// The fastest of up to three cold walks (each on a fresh rig, so none is warmed by the one before): one wall-clock sample that a loaded machine stalls is not a slow walk, three over the goal are (#15480).
	var files, pages int
	var allocMB float64
	// On a developer's machine the goal is read from the walk's CPU time (a loaded box stretches the wall clock, not the CPU); where the platform does not say (Windows) or on CI (its own wall ceiling, above), the wall clock.
	_, haveCPU := processCPU()
	byCPU := haveCPU && os.Getenv("CI") == ""
	if byCPU {
		ceiling = time.Duration(float64(goalNeedsYouWalkCPUMs)*scale) * time.Millisecond
	}
	elapsed := fastestWithin(3, ceiling, func(attempt int) time.Duration {
		_, srv, _ := bigBoardWalkRig(t, true)
		var m0, m1 runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&m0)
		cpu0, _ := processCPU()
		t0 := time.Now()
		files, pages = walkForReview(t, srv)
		d := time.Since(t0)
		if cpu1, ok := processCPU(); ok && byCPU {
			t.Logf("PERF walk %d: %s wall, %s CPU", attempt+1, d.Round(time.Millisecond), (cpu1 - cpu0).Round(time.Millisecond))
			d = cpu1 - cpu0
		}
		runtime.ReadMemStats(&m1)
		if a := float64(m1.TotalAlloc-m0.TotalAlloc) / (1 << 20); attempt == 0 || a > allocMB {
			allocMB = a // the allocation bound reads the worst run: it is not a clock
		}
		return d
	})
	t.Logf("PERF the walk allocated %.0f MB (bound %d MB)", allocMB, walkAllocBoundMB)
	unit := "wall"
	if byCPU {
		unit = "CPU"
	}
	t.Logf("PERF the cold walk of the for-review list: %d files in %d pages, %s %s (goal %s)", files, pages, elapsed.Round(time.Millisecond), unit, ceiling)
	require.Equal(t, 20000, files, "every file for review is in the walk")
	if elapsed > ceiling {
		t.Errorf("the cold walk of 20,000 for-review files took %s of %s, over the goal's %s (#13522)", elapsed.Round(time.Millisecond), unit, ceiling)
	}
	// An allocation bound, not a clock: the walk of a loaded or slow machine takes longer, but a page that copies the whole list (every matching row, for every page: #13614) allocates gigabytes wherever it runs.
	if allocMB > walkAllocBoundMB {
		t.Errorf("the walk allocated %.0f MB, over the bound's %d MB: a page must not copy the list it is cut from (#13614)", allocMB, walkAllocBoundMB)
	}
	_ = fmt.Sprint
}

// #15480: a stall in one timed walk (a loaded machine) is not a slow walk; three walks over the goal are.
func TestAStalledWalkIsNotASlowWalkButThreeSlowOnesAre(t *testing.T) {
	const budget = 20 * time.Millisecond
	calls := 0
	d := fastestWithin(3, budget, func(int) time.Duration {
		calls++
		if calls == 1 {
			return 3 * budget
		}
		return budget / 2
	})
	require.Less(t, d, budget)
	require.Equal(t, 2, calls, "the second run was within the goal and ended it")

	calls = 0
	d = fastestWithin(3, budget, func(int) time.Duration { calls++; return time.Duration(5-calls) * budget })
	require.Greater(t, d, budget, "three slow runs are a slow walk")
	require.Equal(t, 3, calls)
	require.Equal(t, 2*budget, d, "the fastest of the three")

	calls = 0
	fastestWithin(3, budget, func(int) time.Duration { calls++; return budget / 2 })
	require.Equal(t, 1, calls, "an unloaded machine reads one")
}
