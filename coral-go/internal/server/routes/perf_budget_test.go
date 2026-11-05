package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// #13157 (goal #215, the perf sprint): the dashboard's hot reads against the big-board shape (20,000 uploads = 200 files x 100 versions, 2,000 tasks, board messages), in one process, on the real
// handlers, in the normal go test run. Each route has a p95 ceiling in perfBudgets: the goal's API budget (500 ms) where the route is already inside it, and QA's #13154 baseline plus margin where a pending fix
// will tighten it (the "tightens" note names the task). A regression fails the test. It times the handlers in one process (no network, no browser), warms each route, takes N samples per round and the
// median of three rounds' p95, so one slow moment on a busy machine does not fail the gate. Skipped with -short.

type perfBudget struct {
	name     string
	path     string
	coldMs   float64 // the first read after a start (nothing cached)
	warmMs   float64 // p95 of warm reads
	tightens string  // the task whose fix lowers a ceiling; "" when the route is at the goal's budget
}

const goalAPIp95Ms = 500

func TestBigBoardRoutesStayInsideTheirBudgets(t *testing.T) {
	if testing.Short() {
		t.Skip("the big-board budgets seed 20,000 uploads: skipped with -short")
	}
	start := time.Now()
	_, h := setupBoardTestServer(t)
	coralDir := t.TempDir()
	h.SetTaskArtifactWriter(coralDir, nil)
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	ctx := context.Background()

	seedBigUploads(t, coralDir, 20000) // 20,000 uploads: 200 files x 100 versions
	// 2,000 tasks.
	for i := 0; i < 2000; i++ {
		_, err := h.bs.CreateTask(ctx, "alpha", fmt.Sprintf("task %04d", i), "a body of a few words", "medium", "Alice")
		require.NoError(t, err)
	}
	// Board messages through the store's own post.
	for i := 0; i < 5000; i++ {
		_, err := h.bs.PostMessage(ctx, "alpha", "Alice", fmt.Sprintf("message %d on the big board", i), nil)
		require.NoError(t, err)
	}
	seeded := time.Since(start)
	time.Sleep(4 * time.Second) // the upload directory cache trusts a folder only once it has been unchanged for a while: let it settle, as it does in use

	person := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { fn(w, asPerson(r)) }
	}
	r := chi.NewRouter()
	r.Get("/api/board/{project}/artifacts", person(h.ListTeamArtifacts))
	r.Get("/api/team-artifacts", person(h.ListAllTeamArtifacts))
	r.Get("/api/board/tasks", person(h.ListAllTasks))
	r.Get("/api/board/{project}/messages/all", person(h.ListAllMessages))
	r.Get("/api/needs-you", person(h.NeedsYou))
	r.Get("/api/board/projects", person(h.ListProjects))
	r.Get("/api/board/{project}/subscribers", person(h.ListSubscribers))
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	budgets := []perfBudget{
		{"board artifacts", "/api/board/alpha/artifacts", 2000, goalAPIp95Ms, "cold: #13292 (the Lead's cold read)"},
		{"team artifacts", "/api/team-artifacts", 1000, goalAPIp95Ms, "cold: #13292"},
		{"tasks, no filter", "/api/board/tasks", goalAPIp95Ms, goalAPIp95Ms, ""},
		{"messages, latest page", "/api/board/alpha/messages/all?limit=100", goalAPIp95Ms, goalAPIp95Ms, ""},
		{"needs you", "/api/needs-you", 1000, goalAPIp95Ms, "cold: #13304 (Needs you through the Hub)"},
		{"board projects", "/api/board/projects", goalAPIp95Ms, goalAPIp95Ms, ""},
		{"subscribers", "/api/board/alpha/subscribers", goalAPIp95Ms, goalAPIp95Ms, ""},
	}
	// CORAL_PERF_BUDGET_SCALE multiplies every ceiling (1 by default): 0.001 shows the test failing, as a regression would.
	scale := 1.0
	if v := os.Getenv("CORAL_PERF_BUDGET_SCALE"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			scale = f
		}
	}
	for i := range budgets {
		budgets[i].coldMs *= scale
		budgets[i].warmMs *= scale
	}
	type result struct {
		b         perfBudget
		cold, p95 float64
	}
	var results []result
	for _, b := range budgets {
		get := func() float64 {
			t0 := time.Now()
			resp, err := http.Get(srv.URL + b.path)
			require.NoError(t, err)
			resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode, b.path)
			return float64(time.Since(t0).Microseconds()) / 1000
		}
		cold := get() // the first read after the seed: nothing cached, the number the Operator sees on a fresh start
		var p95s []float64
		for round := 0; round < 3; round++ {
			var ms []float64
			for i := 0; i < 20; i++ {
				ms = append(ms, get())
			}
			sort.Float64s(ms)
			p95s = append(p95s, ms[int(float64(len(ms))*0.95)-1])
		}
		sort.Float64s(p95s)
		results = append(results, result{b, cold, p95s[1]})
		t.Logf("%-32s first read %8.1f ms (ceiling %6.0f)   warm p95 %8.1f ms (ceiling %6.0f) %s", b.name, cold, b.coldMs, p95s[1], b.warmMs, b.tightens)
	}
	t.Logf("seeded in %s, total %s", seeded.Round(time.Millisecond), time.Since(start).Round(time.Millisecond))
	for _, res := range results {
		if res.p95 > res.b.warmMs {
			t.Errorf("%s: warm p95 %.1f ms is over its %.0f ms budget (%s)", res.b.name, res.p95, res.b.warmMs, res.b.path)
		}
		if res.cold > res.b.coldMs {
			t.Errorf("%s: the first read took %.1f ms, over its %.0f ms budget (%s)", res.b.name, res.cold, res.b.coldMs, res.b.path)
		}
	}
}

// seedBigUploads writes n uploads for session sessAlice into coralDir: 200 files x n/200 versions, each a stored blob with its sidecar and the upload record, as a real one has. It returns the digests, newest last.
func seedBigUploads(t *testing.T, coralDir string, n int) []string {
	t.Helper()
	var ids []string
	dir := uploadsDir(coralDir, sessAlice)
	objDir := filepath.Join(coralDir, "artifacts", "objects")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.MkdirAll(objDir, 0o755))
	base := time.Now().UTC().Add(-48 * time.Hour)
	for i := 0; i < n; i++ {
		name := fmt.Sprintf("doc-%03d.md", i%200)
		content := fmt.Sprintf("version %d of %s\n", i/200, name)
		sum := sha256.Sum256([]byte(content + name))
		id := hex.EncodeToString(sum[:])
		require.NoError(t, os.WriteFile(filepath.Join(objDir, id), []byte(content), 0o644))
		meta, _ := json.Marshal(agentArtifactMeta{Name: name, MediaType: "text/markdown", Size: int64(len(content)), Digest: "sha256:" + id})
		require.NoError(t, os.WriteFile(filepath.Join(objDir, id+".json"), meta, 0o644))
		rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: name, MediaType: "text/markdown", Size: int64(len(content)), Digest: "sha256:" + id}, CreatedAt: base.Add(time.Duration(i) * time.Second).Format(time.RFC3339)})
		require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), rec, 0o644))
		ids = append(ids, id)
	}
	return ids
}
