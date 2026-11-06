package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13172: facets=by,goal,team on the artifacts list: the distinct values of the matching set with their counts, each with its own filter left out, so a Filters panel still offers the other choices after one is picked.
type facetReply struct {
	Total  *int                            `json:"total"`
	Facets map[string][]artifactFacetValue `json:"facets"`
}

func getFacets(t *testing.T, url string) (int, facetReply) {
	t.Helper()
	resp, err := http.Get(url)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var r facetReply
	_ = json.Unmarshal(b, &r)
	return resp.StatusCode, r
}

func factsOf(vals []artifactFacetValue) map[string]int {
	m := map[string]int{}
	for _, v := range vals {
		m[v.V] = v.N
	}
	return m
}

func TestTheByFacetCountsWhoProducedTheMatchingSetAndLeavesItsOwnFilterOut(t *testing.T) {
	e := newTAEnv(t)
	// what a full read says: the producers of every row, tallied here from the list itself
	_, full, _ := e.get("?limit=200")
	want := map[string]int{}
	for _, a := range full.Artifacts {
		if who := ptrOr(a.ProducedBy); who != "" {
			want[who]++
		} else if a.SentBy != "" {
			want[a.SentBy]++
		}
	}
	require.NotEmpty(t, want)
	code, r := getFacets(t, e.srv.URL+"/api/board/alpha/artifacts?facets=by&limit=1")
	require.Equal(t, 200, code)
	assert.Equal(t, want, factsOf(r.Facets["by"]), "the facet is the tally of a full read")
	require.NotEmpty(t, r.Facets["by"])
	for i := 1; i < len(r.Facets["by"]); i++ {
		a, b := r.Facets["by"][i-1], r.Facets["by"][i]
		assert.True(t, a.N > b.N || (a.N == b.N && a.V <= b.V), "most files first, then by name")
	}

	// the by filter narrows the list, not its own facet: the other producers are still offered
	code, one := getFacets(t, e.srv.URL+"/api/board/alpha/artifacts?facets=by&by=alice&limit=1")
	require.Equal(t, 200, code)
	assert.Equal(t, want, factsOf(one.Facets["by"]), "with by=alice the facet still lists everyone")
	assert.Less(t, *one.Total, *r.Total, "while the list itself is narrowed")

	// another filter does narrow it
	_, uploads := getFacets(t, e.srv.URL+"/api/board/alpha/artifacts?facets=by&origin=upload&limit=1")
	n := 0
	for _, v := range uploads.Facets["by"] {
		n += v.N
	}
	assert.Equal(t, *uploads.Total, n, "the counts of an origin=upload read add up to its rows")
}

func TestTheGoalFacetNamesGoalsWithTheirNumbersAndCounts(t *testing.T) {
	srv, g1, g2, _, _, _ := goalArtifactsEnv(t)
	code, r := getFacets(t, srv.URL+"/api/board/g-team/artifacts?facets=goal&limit=1")
	require.Equal(t, 200, code)
	got := map[int64]artifactFacetValue{}
	for _, v := range r.Facets["goal"] {
		got[v.ID] = v
	}
	assert.Equal(t, artifactFacetValue{V: "Ship the report", N: 2, ID: g1.ID}, got[g1.ID], "the report's two files")
	assert.Equal(t, artifactFacetValue{V: "Tidy the docs", N: 1, ID: g2.ID}, got[g2.ID])
	assert.Len(t, got, 2, "a file whose task has no goal is in no goal")
	_, narrowed := getFacets(t, srv.URL+"/api/board/g-team/artifacts?facets=goal&goal="+itoa(g1.ID)+"&limit=1")
	assert.Len(t, narrowed.Facets["goal"], 2, "picking a goal still offers the others")
	assert.Equal(t, 2, *narrowed.Total)
}

func TestFacetsAreAClosedList(t *testing.T) {
	e := newTAEnv(t)
	for _, q := range []string{"?facets=bogus", "?facets=", "?facets=by,,goal", "?facets=by&facets=goal", "?facets=BY", "?facets=kind"} {
		code, _, _ := e.get(q)
		assert.Equal(t, 400, code, q)
	}
	code, r := getFacets(t, e.srv.URL+"/api/board/alpha/artifacts?facets=by,goal,team,by&limit=1")
	require.Equal(t, 200, code)
	assert.Len(t, r.Facets, 3, "three facets, a repeat is one")
	code, plain := getFacets(t, e.srv.URL+"/api/board/alpha/artifacts?limit=1")
	require.Equal(t, 200, code)
	assert.Nil(t, plain.Facets, "no facets unless asked for")
}

func TestAFacetAnswersAtMost100ChoicesMostFilesFirst(t *testing.T) {
	var set []teamArtifact
	for i := 0; i < 150; i++ {
		who := fmt.Sprintf("agent-%03d", i)
		for k := 0; k <= i%3; k++ {
			set = append(set, teamArtifact{ProducedBy: &who})
		}
	}
	out := artifactFacetOf("by", set)
	require.Len(t, out, maxFacetValues)
	assert.Equal(t, 3, out[0].N, "the most files first")
	assert.Equal(t, "agent-002", out[0].V, "ties by name")
}

func TestFacetCountsFilesNotVersionsWithVersionsNewest(t *testing.T) {
	e := newTAEnv(t)
	e.upload(sessAlice, "series.md", "v1 body", "text/markdown", "2026-10-10T10:00:00Z")
	e.upload(sessAlice, "series.md", "v2 body, longer", "text/markdown", "2026-10-11T10:00:00Z")
	e.upload(sessAlice, "series.md", "v3 body, longer still", "text/markdown", "2026-10-12T10:00:00Z")
	count := func(q string) int {
		_, r := getFacets(t, e.srv.URL+"/api/board/alpha/artifacts?facets=by&q=series.md&limit=1"+q)
		return factsOf(r.Facets["by"])["Alice"]
	}
	assert.Equal(t, 3, count(""), "three versions are three rows")
	assert.Equal(t, 1, count("&versions=newest"), "with versions=newest the file is one, as the totals say")
}

// #13378 (2): the team facet leaves its own filter (team=) out: picking a team narrows the list and still offers every team. (The first version of this pin used board=, which is the OTHER board of a shared or received file;
// the team a list is for is team=, which only chose which teams were read, so the facet could not offer the others: now it reads them for the facet and filters the list.)
func TestTheTeamFacetLeavesItsOwnBoardFilterOut(t *testing.T) {
	t.Parallel()
	srv, h := allTeamArtifactsServer(t)
	twoTeamsFourResults(t, h)
	teams := func(q string) (map[string]int, int) {
		code, r := getFacets(t, srv.URL+"/api/team-artifacts?"+q)
		require.Equal(t, 200, code, q)
		return factsOf(r.Facets["team"]), *r.Total
	}
	all, total := teams("facets=team&limit=1")
	assert.Equal(t, map[string]int{"alpha": 2, "beta": 2}, all)
	assert.Equal(t, 4, total)
	picked, total := teams("facets=team&team=alpha&limit=1")
	assert.Equal(t, 2, total, "the list is narrowed to the picked team")
	assert.Equal(t, map[string]int{"alpha": 2, "beta": 2}, picked, "and the team facet still offers every team (its own filter is left out)")
	other, total := teams("facets=team&q=alpha&limit=1")
	assert.Equal(t, 2, total)
	assert.Equal(t, map[string]int{"alpha": 2}, other, "another filter does narrow it")
}

// #13378 (3): goals are told apart by their number: two goals with one title are two choices, each with its own id and count.
func TestTwoGoalsWithOneTitleAreTwoGoalChoices(t *testing.T) {
	srv, h, _ := teamArtifactServer(t)
	ctx := context.Background()
	g1, err := h.bs.CreateGoal(ctx, "g-team", board.GoalInput{Title: "Tidy the docs", CreatedBy: "lead"})
	require.NoError(t, err)
	g2, err := h.bs.CreateGoal(ctx, "g-team", board.GoalInput{Title: "Tidy the docs", CreatedBy: "lead"})
	require.NoError(t, err)
	for i, g := range []*board.Goal{g1, g1, g2} {
		task, err := h.bs.CreateTaskWithOpts(ctx, "g-team", "task", "", "medium", "lead", &board.CreateTaskOpts{GoalID: &g.ID}, "lead")
		require.NoError(t, err)
		_, err = h.bs.CompleteTaskWithArtifacts(ctx, "g-team", task.ID, "lead", nil, "success", []board.TaskArtifact{{Name: fmt.Sprintf("f%d.md", i), Content: "x"}})
		require.NoError(t, err)
	}
	code, r := getFacets(t, srv.URL+"/api/board/g-team/artifacts?facets=goal&limit=1")
	require.Equal(t, 200, code)
	got := map[int64]artifactFacetValue{}
	for _, v := range r.Facets["goal"] {
		got[v.ID] = v
	}
	require.Len(t, got, 2, "two goals, two choices, though they share a title: %v", r.Facets["goal"])
	assert.Equal(t, artifactFacetValue{V: "Tidy the docs", N: 2, ID: g1.ID}, got[g1.ID])
	assert.Equal(t, artifactFacetValue{V: "Tidy the docs", N: 1, ID: g2.ID}, got[g2.ID])
}

// #13378 (1): with a search, the list and every facet are separate passes over the files; each file's sidecar is read once, not once per pass (q + by + three facets was twice the cost of q + by).
func TestEachFilesSidecarIsReadOnceForTheListAndEveryFacet(t *testing.T) {
	e := newTAEnv(t)
	read := func(q string) int64 {
		before := teamArtifactEnrichments.Load()
		code, _, raw := e.get(q)
		require.Equal(t, 200, code, taJSON(raw))
		return teamArtifactEnrichments.Load() - before
	}
	plain := read("?q=md&by=alice&limit=1")
	require.Positive(t, plain, "a search reads sidecars")
	_, full, _ := e.get("?sort=newest&limit=1")
	withFacets := read("?q=md&by=alice&facets=by,goal,team&limit=1")
	assert.LessOrEqual(t, withFacets, int64(*full.All), "every file at most once in all the passes together (the list narrowed to alice, the by facet over everyone's, the others): without the memo each pass read its own")
	assert.Greater(t, withFacets, plain, "the by facet did read the files the by filter had left out")
}
