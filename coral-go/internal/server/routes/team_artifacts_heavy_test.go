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
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

// seedHeavyUser writes what the Operator's real Coral held when #20392 walked it: two teams of 11 agents, hundreds of task results and uploads per team, and 1,000 chats on no team with
// 20 uploads each (21,986 artifacts in all). Records are written directly so the seed takes a second, not a minute.
func seedHeavyUser(t *testing.T, h *BoardHandler, coralDir string) {
	t.Helper()
	write := func(sid string, n int) {
		dir := uploadsDir(coralDir, sid)
		require.NoError(t, os.MkdirAll(dir, 0o755))
		for u := range n {
			sum := sha256.Sum256([]byte(fmt.Sprintf("%s-%d", sid, u)))
			id := hex.EncodeToString(sum[:])
			rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: fmt.Sprintf("file-%d.md", u), MediaType: "text/markdown", Size: 10, Digest: "sha256:" + id}, CreatedAt: fmt.Sprintf("2026-10-09T10:%02d:%02dZ", u%60, u/60)})
			require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), rec, 0o644))
		}
		past := time.Now().Add(-time.Hour)
		_ = os.Chtimes(dir, past, past)
	}
	for _, team := range []string{"coral-go-team", "coral-hub"} {
		for a := range 11 {
			sid := fmt.Sprintf("%08x-%04x-4000-8000-%012x", len(team)*1000+a, a, a)
			_, err := h.bs.Subscribe(context.Background(), team, fmt.Sprintf("Agent %d", a), fmt.Sprintf("Agent %d", a), "claude-"+sid, nil, "all")
			require.NoError(t, err)
			write(sid, 400)
		}
	}
	for c := range 1000 {
		write(fmt.Sprintf("%08x-beef-4000-8000-%012x", c, c), 18)
	}
}

func heavyServer(t *testing.T) (*httptest.Server, *BoardHandler, string) {
	_, h := setupBoardTestServer(t)
	coralDir := t.TempDir()
	h.SetTaskArtifactWriter(coralDir, nil)
	r := chi.NewRouter()
	r.Get("/api/team-artifacts", h.ListAllTeamArtifacts)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, h, coralDir
}

var heavyQueries = map[string]string{
	"waiting-on-you": "tag=for%20review&waiting=1&muted=0&versions=newest&limit=1",
	"facets":         "facets=team&starred_first=1&versions=newest&limit=50",
	"saved":          "tag=saved&versions=newest&limit=50",
}

func timeHeavy(t *testing.T, srv *httptest.Server, q string) time.Duration {
	start := time.Now()
	resp, err := http.Get(srv.URL + "/api/team-artifacts?" + q)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	return time.Since(start)
}

func TestHeavyUserTeamArtifactsTiming(t *testing.T) {
	if os.Getenv("CORAL_PERF") == "" {
		t.Skip("set CORAL_PERF=1 for the heavy-user timing (#20396)")
	}
	srv, h, coralDir := heavyServer(t)
	seedHeavyUser(t, h, coralDir)
	for name, q := range heavyQueries {
		for _, team := range []string{"coral-go-team", ""} {
			full := q
			if team != "" {
				full += "&team=" + team
			}
			cold := timeHeavy(t, srv, full)
			warm := timeHeavy(t, srv, full)
			t.Logf("%-16s team=%-14q cold %v warm %v", name, team, cold.Round(time.Millisecond), warm.Round(time.Millisecond))
		}
	}
}
