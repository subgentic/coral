package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
)

type allTeamArtifactsResponse struct {
	Artifacts  []teamArtifact        `json:"artifacts"`
	Limit      int                   `json:"limit"`
	Offset     int                   `json:"offset"`
	HasMore    bool                  `json:"has_more"`
	Truncated  bool                  `json:"truncated"`
	Total      int                   `json:"total"`
	All        int                   `json:"all"`
	NextCursor string                `json:"next_cursor"`
	Teams      []teamArtifactTeamRef `json:"teams"`
}

func allTeamArtifactsServer(t *testing.T) (*httptest.Server, *BoardHandler) {
	t.Helper()
	_, h := setupBoardTestServer(t)
	h.SetTaskArtifactWriter(t.TempDir(), nil)
	r := chi.NewRouter()
	r.Get("/api/team-artifacts", h.ListAllTeamArtifacts)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, h
}

func getAllTeamArtifacts(t *testing.T, srv *httptest.Server, query string, wantStatus int) allTeamArtifactsResponse {
	t.Helper()
	resp, err := http.Get(srv.URL + "/api/team-artifacts" + query)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, wantStatus, resp.StatusCode)
	var out allTeamArtifactsResponse
	if wantStatus == http.StatusOK {
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	}
	return out
}

// Two teams, four inline results, completed in turn: alpha 1, beta 1, alpha 2, beta 2 (the completion times differ, so the order is newest first across both teams).
func twoTeamsFourResults(t *testing.T, h *BoardHandler) {
	t.Helper()
	subscribeSession(t, h, "alpha", "Alice", "00000000-0000-4000-8000-0000000000a1")
	subscribeSession(t, h, "beta", "Bob", "00000000-0000-4000-8000-0000000000b2")
	for _, step := range []struct{ project, title, name string }{
		{"alpha", "A one", "alpha-1.md"}, {"beta", "B one", "beta-1.md"}, {"alpha", "A two", "alpha-2.md"}, {"beta", "B two", "beta-2.md"},
	} {
		completeWithArtifacts(t, h, step.project, step.title, []board.TaskArtifact{{Name: step.name, Content: "text of " + step.name}})
		time.Sleep(1100 * time.Millisecond) // created_at has a one-second grain
	}
}

func names(items []teamArtifact) []string {
	var out []string
	for _, it := range items {
		out = append(out, it.Name)
	}
	return out
}

func TestAllTeamArtifactsMergesTeamsNewestFirstAndNamesTheTeam(t *testing.T) {
	srv, h := allTeamArtifactsServer(t)
	twoTeamsFourResults(t, h)
	got := getAllTeamArtifacts(t, srv, "", http.StatusOK)
	require.Equal(t, []string{"beta-2.md", "alpha-2.md", "beta-1.md", "alpha-1.md"}, names(got.Artifacts), "one list, newest first across both teams")
	require.Equal(t, 4, got.Total)
	require.Equal(t, 4, got.All)
	for _, it := range got.Artifacts {
		require.NotEmpty(t, it.BoardID)
		require.Equal(t, it.BoardID, it.Team, "a team without a label is named by its id")
	}
	require.Equal(t, "beta", got.Artifacts[0].BoardID)
	require.Equal(t, "alpha", got.Artifacts[1].BoardID)
	require.ElementsMatch(t, []teamArtifactTeamRef{{BoardID: "alpha", Team: "alpha", All: 2}, {BoardID: "beta", Team: "beta", All: 2}}, got.Teams)
}

func TestAllTeamArtifactsOneCursorAcrossPages(t *testing.T) {
	srv, h := allTeamArtifactsServer(t)
	twoTeamsFourResults(t, h)
	first := getAllTeamArtifacts(t, srv, "?limit=3", http.StatusOK)
	require.Equal(t, []string{"beta-2.md", "alpha-2.md", "beta-1.md"}, names(first.Artifacts))
	require.True(t, first.HasMore)
	require.NotEmpty(t, first.NextCursor)
	require.Equal(t, 4, first.Total, "the total is the matching rows, not the page")
	second := getAllTeamArtifacts(t, srv, "?limit=3&cursor="+url.QueryEscape(first.NextCursor), http.StatusOK)
	require.Equal(t, []string{"alpha-1.md"}, names(second.Artifacts), "the cursor crosses the page boundary and the team boundary without a repeat or a gap")
	require.False(t, second.HasMore)
	require.Empty(t, second.NextCursor)
}

func TestAllTeamArtifactsTeamFilterByIdOrName(t *testing.T) {
	srv, h := allTeamArtifactsServer(t)
	twoTeamsFourResults(t, h)
	only := getAllTeamArtifacts(t, srv, "?team=alpha", http.StatusOK)
	require.Equal(t, []string{"alpha-2.md", "alpha-1.md"}, names(only.Artifacts))
	require.Equal(t, 2, only.Total)
	both := getAllTeamArtifacts(t, srv, "?team=alpha&team=beta", http.StatusOK)
	require.Equal(t, 4, both.Total)
	none := getAllTeamArtifacts(t, srv, "?team=nobody", http.StatusOK)
	require.Empty(t, none.Artifacts, "a team nobody has adds nothing")
	require.Equal(t, 0, none.Total)
	// a cursor made for one team filter is refused under another
	first := getAllTeamArtifacts(t, srv, "?team=alpha&limit=1", http.StatusOK)
	require.NotEmpty(t, first.NextCursor)
	getAllTeamArtifacts(t, srv, "?team=beta&limit=1&cursor="+url.QueryEscape(first.NextCursor), http.StatusBadRequest)
}

func TestAllTeamArtifactsQueryAcrossTeamsAndRefusedParameters(t *testing.T) {
	srv, h := allTeamArtifactsServer(t)
	twoTeamsFourResults(t, h)
	hit := getAllTeamArtifacts(t, srv, "?q=-2", http.StatusOK)
	require.Equal(t, []string{"beta-2.md", "alpha-2.md"}, names(hit.Artifacts), "a search covers every team")
	require.Equal(t, 2, hit.Total)
	require.Equal(t, 4, hit.All, "all is what the teams hold before the filters")
	old := getAllTeamArtifacts(t, srv, "?sort=oldest&limit=2", http.StatusOK)
	require.Equal(t, []string{"alpha-1.md", "beta-1.md"}, names(old.Artifacts))
	getAllTeamArtifacts(t, srv, "?session_id=x", http.StatusBadRequest) // one agent's list is the team route's
	getAllTeamArtifacts(t, srv, "?bogus=1", http.StatusBadRequest)
	getAllTeamArtifacts(t, srv, "?limit=0", http.StatusBadRequest)
	getAllTeamArtifacts(t, srv, "?kind=zip", http.StatusBadRequest)
}

func TestAllTeamArtifactsOneDigestInTwoTeamsIsTwoRows(t *testing.T) {
	srv, h := allTeamArtifactsServer(t)
	subscribeSession(t, h, "alpha", "Alice", "00000000-0000-4000-8000-0000000000a1")
	subscribeSession(t, h, "beta", "Bob", "00000000-0000-4000-8000-0000000000b2")
	same := storeManagedArtifact(t, h.coralDir, "shared bytes", true, true)
	for _, project := range []string{"alpha", "beta"} {
		completeWithArtifacts(t, h, project, "Uses it", []board.TaskArtifact{{Name: "shared.md", URI: "coral://artifacts/" + same}})
	}
	got := getAllTeamArtifacts(t, srv, "?limit=1", http.StatusOK)
	require.Equal(t, 2, got.Total, "the same digest in two teams is two rows")
	next := getAllTeamArtifacts(t, srv, "?limit=1&cursor="+url.QueryEscape(got.NextCursor), http.StatusOK)
	require.Len(t, next.Artifacts, 1)
	require.NotEqual(t, got.Artifacts[0].BoardID, next.Artifacts[0].BoardID, "the cursor moves to the other team's row")
}

func TestAllTeamArtifactsSortKeyTellsTwoTeamsApart(t *testing.T) {
	a := teamArtifact{ID: "same", CreatedAt: "2026-10-26T10:00:00Z", TaskID: 1, Source: "task", BoardID: "alpha"}
	b := a
	b.BoardID = "beta"
	require.NotEqual(t, keyOf(a).ID, keyOf(b).ID, "one digest, one time, one task number in two teams: the tie-break is the team")
	solo := a
	solo.BoardID = ""
	require.Equal(t, keyOf(solo).ID, keyOf(teamArtifact{ID: "same"}).ID, "a team's own list keeps its cursors' keys")
}

func TestAllTeamArtifactsCursorsDoNotCrossRoutes(t *testing.T) {
	srv, h := allTeamArtifactsServer(t)
	twoTeamsFourResults(t, h)
	// the team route's cursor is refused by the cross-team list, and the cross-team list's by the team route
	r := chi.NewRouter()
	r.Get("/api/board/{project}/artifacts", h.ListTeamArtifacts)
	team := httptest.NewServer(r)
	t.Cleanup(team.Close)
	resp, err := http.Get(team.URL + "/api/board/alpha/artifacts?sort=newest&limit=1")
	require.NoError(t, err)
	var teamPage struct {
		NextCursor string `json:"next_cursor"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&teamPage))
	resp.Body.Close()
	require.NotEmpty(t, teamPage.NextCursor)
	getAllTeamArtifacts(t, srv, "?sort=newest&limit=1&cursor="+url.QueryEscape(teamPage.NextCursor), http.StatusBadRequest)
	cross := getAllTeamArtifacts(t, srv, "?sort=newest&limit=1", http.StatusOK)
	require.NotEmpty(t, cross.NextCursor)
	resp, err = http.Get(team.URL + "/api/board/alpha/artifacts?sort=newest&limit=1&cursor=" + url.QueryEscape(cross.NextCursor))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusBadRequest, resp.StatusCode)
	// and a caller cannot send the marker itself
	getAllTeamArtifacts(t, srv, "?_scope=all", http.StatusBadRequest)
}
