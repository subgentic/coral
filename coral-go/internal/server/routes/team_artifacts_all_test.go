package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
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
	t.Parallel() // its own store and server; the 4 x 1.1 s of waiting for the one-second grain overlaps (#9432)
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
	t.Parallel() // its own store and server; the 4 x 1.1 s of waiting for the one-second grain overlaps (#9432)
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
	t.Parallel() // its own store and server; the 4 x 1.1 s of waiting for the one-second grain overlaps (#9432)
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
	t.Parallel() // its own store and server; the 4 x 1.1 s of waiting for the one-second grain overlaps (#9432)
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
	t.Parallel() // its own store and server; the 4 x 1.1 s of waiting for the one-second grain overlaps (#9432)
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
	t.Parallel() // its own store and server; the 4 x 1.1 s of waiting for the one-second grain overlaps (#9432)
	a := teamArtifact{ID: "same", CreatedAt: "2026-10-26T10:00:00Z", TaskID: 1, Source: "task", BoardID: "alpha"}
	b := a
	b.BoardID = "beta"
	require.NotEqual(t, keyOf(a).ID, keyOf(b).ID, "one digest, one time, one task number in two teams: the tie-break is the team")
	solo := a
	solo.BoardID = ""
	require.Equal(t, keyOf(solo).ID, keyOf(teamArtifact{ID: "same"}).ID, "a team's own list keeps its cursors' keys")
}

func TestAllTeamArtifactsCursorsDoNotCrossRoutes(t *testing.T) {
	t.Parallel() // its own store and server; the 4 x 1.1 s of waiting for the one-second grain overlaps (#9432)
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

// #10312: the Inbox's Artifacts folder and an agent's own Artifacts tab list the same files. A file an agent with no team uploaded (a pasted screenshot) is in the agent's tab, so it is in the folder too,
// under "Not on a team"; a file a team already lists is not repeated; the Team filter takes "Not on a team".
func TestAllTeamArtifactsListsTheFilesOfAgentsWithoutATeam(t *testing.T) {
	_, h := setupBoardTestServer(t)
	coralDir := t.TempDir()
	h.SetTaskArtifactWriter(coralDir, nil)
	r := chi.NewRouter()
	r.Get("/api/team-artifacts", h.ListAllTeamArtifacts)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	empty := getAllTeamArtifacts(t, srv, "", http.StatusOK)
	require.Zero(t, empty.All, "nothing yet")

	writeUpload(t, coralDir, "solo-1", "pasted screen", "screen.png", "2026-10-09T10:00:00Z")
	got := getAllTeamArtifacts(t, srv, "", http.StatusOK)
	require.Equal(t, 1, got.All, "the standalone agent's file is in the folder")
	require.Equal(t, []string{"screen.png"}, names(got.Artifacts))
	require.Equal(t, "Not on a team", got.Artifacts[0].Team)
	require.Equal(t, []teamArtifactTeamRef{{BoardID: noTeamBoardID, Team: "Not on a team", All: 1}}, got.Teams)
	require.Equal(t, noTeamBoardID, got.Artifacts[0].BoardID, "the row carries the reserved key a file for review is kept under (#13527)")

	subscribeSession(t, h, "alpha", "Alice", "00000000-0000-4000-8000-0000000000a1")
	completeWithArtifacts(t, h, "alpha", "A one", []board.TaskArtifact{{Name: "alpha-1.md", Content: "text"}})
	writeUpload(t, coralDir, "00000000-0000-4000-8000-0000000000a1", "alice's upload", "alice.md", "2026-10-09T11:00:00Z")
	both := getAllTeamArtifacts(t, srv, "", http.StatusOK)
	require.ElementsMatch(t, []string{"screen.png", "alpha-1.md", "alice.md"}, names(both.Artifacts), "each file once: a team member's upload is its team's, not the no-team list's")
	for _, a := range both.Artifacts {
		if a.Name == "alice.md" {
			require.Equal(t, "alpha", a.BoardID, "a team agent's file stays with its team")
		}
	}

	only := getAllTeamArtifacts(t, srv, "?team=Not+on+a+team", http.StatusOK)
	require.Equal(t, []string{"screen.png"}, names(only.Artifacts), "the Team filter takes Not on a team")
	notThem := getAllTeamArtifacts(t, srv, "?team=alpha", http.StatusOK)
	require.NotContains(t, names(notThem.Artifacts), "screen.png", "a team's filter leaves the no-team files out")
}

// #13151: the Inbox's sidebar count is `all` of this route read with versions=newest: the files of every team, not their versions. `all` and each team's own `all` counted every version (20,013 for 213 files at the
// scale of the Operator's Hub: 21,117 for 647), while `total` and the per-team route already counted files (#11700).
func TestAllTeamArtifactsAllCountsFilesNotVersionsWithVersionsNewest(t *testing.T) {
	t.Parallel()
	srv, h := allTeamArtifactsServer(t)
	const alice, bob = "00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b2"
	subscribeSession(t, h, "alpha", "Alice", alice)
	subscribeSession(t, h, "beta", "Bob", bob)
	up := func(session, name, body, at string) {
		t.Helper()
		id := storeTyped(t, h.coralDir, body, name, "text/markdown")
		dir := uploadsDir(h.coralDir, session)
		require.NoError(t, os.MkdirAll(dir, 0o755))
		rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: name, MediaType: "text/markdown", Size: int64(len(body)), Digest: "sha256:" + id}, CreatedAt: at})
		require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), rec, 0o644))
	}
	up(alice, "design.md", "d1", "2026-10-01T10:00:00Z")
	up(alice, "design.md", "d2", "2026-10-02T10:00:00Z")
	up(alice, "design.md", "d3", "2026-10-03T10:00:00Z")
	up(alice, "other.md", "o1", "2026-10-04T10:00:00Z")
	up(bob, "plan.md", "p1", "2026-10-05T10:00:00Z")
	up(bob, "plan.md", "p2", "2026-10-06T10:00:00Z")

	versions := getAllTeamArtifacts(t, srv, "?limit=1&versions=all", http.StatusOK)
	require.Equal(t, 6, versions.All, "every version, as asked")
	files := getAllTeamArtifacts(t, srv, "?limit=1&versions=newest", http.StatusOK)
	require.Equal(t, 3, files.Total, "the files, as before")
	require.Equal(t, 3, files.All, "the unfiltered count is the files too, not the 6 versions")
	byTeam := map[string]int{}
	for _, ref := range files.Teams {
		byTeam[ref.BoardID] = ref.All
	}
	require.Equal(t, map[string]int{"alpha": 2, "beta": 1}, byTeam, "and so is each team's own count")
	plain := getAllTeamArtifacts(t, srv, "?limit=1", http.StatusOK)
	require.Equal(t, 6, plain.All, "without versions=newest a version is a row, as it always was")
}

// #13163 (QA Reviewer 2's SHOULD on #13151): the no-team group's own count is files too. Reverting only the no-team ref in ListAllTeamArtifacts (filesOrVersions to len(rows)) left the test above green, because it
// had only team files. A file with no team that has three versions is one file with versions=newest, and three rows without it; the Team filter "Not on a team" agrees.
func TestAllTeamArtifactsCountsAFileWithNoTeamAsAFileNotItsVersions(t *testing.T) {
	t.Parallel()
	srv, h := allTeamArtifactsServer(t)
	const solo = "00000000-0000-4000-8000-0000000000c3" // an agent that belongs to no team
	up := func(name, body, at string) {
		t.Helper()
		id := storeTyped(t, h.coralDir, body, name, "text/markdown")
		dir := uploadsDir(h.coralDir, solo)
		require.NoError(t, os.MkdirAll(dir, 0o755))
		rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: name, MediaType: "text/markdown", Size: int64(len(body)), Digest: "sha256:" + id}, CreatedAt: at})
		require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), rec, 0o644))
	}
	up("notes.md", "n1", "2026-10-01T10:00:00Z")
	up("notes.md", "n2", "2026-10-02T10:00:00Z")
	up("notes.md", "n3", "2026-10-03T10:00:00Z")
	up("other.md", "o1", "2026-10-04T10:00:00Z")

	noTeamAll := func(q string) (all, group int) {
		got := getAllTeamArtifacts(t, srv, q, http.StatusOK)
		for _, ref := range got.Teams {
			if ref.Team == "Not on a team" {
				group = ref.All
			}
		}
		return got.All, group
	}
	all, group := noTeamAll("?limit=1&versions=newest")
	require.Equal(t, 2, all, "the list's own count is the two files, not the four versions")
	require.Equal(t, 2, group, "and so is the Not on a team group's: the file counts once")
	all, group = noTeamAll("?limit=1&team=Not+on+a+team&versions=newest")
	require.Equal(t, 2, all, "the Not on a team filter agrees")
	require.Equal(t, 2, group)
	all, group = noTeamAll("?limit=1&versions=all")
	require.Equal(t, 4, all, "as asked, every version is a row")
	require.Equal(t, 4, group)
}

// A file a no-team agent sent for review is a review row in the Inbox's list (#13527): its tag and the question it asks are read from the reserved key, the for-review filter finds it, and a file that was not sent
// for review stays a plain row. The row carries the reserved board key and the Not on a team label.
func TestAllTeamArtifactsShowsAFileANoTeamAgentSentForReviewWithItsQuestion(t *testing.T) {
	_, h := setupBoardTestServer(t)
	coralDir := t.TempDir()
	h.SetTaskArtifactWriter(coralDir, nil)
	r := chi.NewRouter()
	r.Get("/api/team-artifacts", h.ListAllTeamArtifacts)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()

	review := writeUpload(t, coralDir, "solo-1", "the report", "report.md", "2026-10-09T10:00:00Z")
	writeUpload(t, coralDir, "solo-1", "just a log", "run.log", "2026-10-09T09:00:00Z")
	_, err := h.bs.AddArtifactTags(ctx, noTeamBoardID, review, []string{"for review"})
	require.NoError(t, err)
	_, err = h.bs.SetArtifactQuestion(ctx, noTeamBoardID, review, "Ship the Q4 report?", "solo-1", time.Now())
	require.NoError(t, err)

	got := getAllTeamArtifacts(t, srv, "?tag=for+review", http.StatusOK)
	require.Equal(t, []string{"report.md"}, names(got.Artifacts), "only the file sent for review")
	row := got.Artifacts[0]
	assert.Equal(t, []string{"for review"}, row.Tags)
	assert.Equal(t, "Ship the Q4 report?", row.ReviewQuestion, "the question reaches the Operator with it")
	assert.Equal(t, "Not on a team", row.Team)
	assert.Equal(t, noTeamBoardID, row.BoardID)
	all := getAllTeamArtifacts(t, srv, "", http.StatusOK)
	assert.ElementsMatch(t, []string{"report.md", "run.log"}, names(all.Artifacts), "the plain file is still listed, with no review")
}
