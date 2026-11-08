package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11890: a row of the team's artifact list says which version of its series it is, with no request of its own, so the Needs you row can say "version 2" even when version 1 was decided long ago. Only an artifact
// in a series of two or more carries it; one in no series (or a series of one) carries nothing, and a row with no stored object is left alone.
func TestTeamArtifactRowsCarryTheirSeriesVersion(t *testing.T) {
	rig, _ := ownerRig(t)
	_, d := seriesOf(t, rig) // three versions of plan.txt
	solo := rig.uploadText("a1", "solo.txt", "no second version")
	h := &BoardHandler{coralDir: rig.coralDir}
	rows := []teamArtifact{{ID: d[0]}, {ID: d[1]}, {ID: d[2]}, {ID: solo}, {ID: "task-link-without-a-stored-object"}}
	h.attachSeriesVersions(rows, "team-a")
	for i, want := range [][2]int{{1, 3}, {2, 3}, {3, 3}, {0, 0}, {0, 0}} {
		assert.Equal(t, want, [2]int{rows[i].Version, rows[i].Versions}, "row %d", i)
	}
	// a store with no series is not read at all
	empty := &BoardHandler{coralDir: t.TempDir()}
	none := []teamArtifact{{ID: d[1]}}
	empty.attachSeriesVersions(none, "team-a")
	assert.Equal(t, [2]int{0, 0}, [2]int{none[0].Version, none[0].Versions})
}

// The same bytes uploaded by two teams are one digest with two records (#11890, Security): team-a makes a series of it, team-b's record of the same bytes names none. A row on team-b's list must not carry
// team-a's version and count (a number about another team's series), whichever record the walk meets first; an all-teams row (no project) follows its own Team.
func TestSameBytesOfTwoTeamsNeverCarryTheOtherTeamsSeries(t *testing.T) {
	rig, _ := ownerRig(t)
	same := rig.uploadText("a1", "plan.txt", "the same bytes")
	require.Equal(t, same, rig.uploadText("b1", "plan.txt", "the same bytes"), "one digest, two teams' records")
	code, out := rig.uploadVersion("a1", "plan.txt", "team a, second", "coral://artifacts/"+same) // team-a's series: 2 versions
	require.Equal(t, 201, code, out)
	h := &BoardHandler{coralDir: rig.coralDir}
	for _, c := range []struct {
		project, team string
		want          [2]int
	}{{"team-a", "", [2]int{1, 2}}, {"team-b", "", [2]int{0, 0}}, {"", "team-a", [2]int{1, 2}}, {"", "team-b", [2]int{0, 0}}, {"team-o", "", [2]int{0, 0}}} {
		rows := []teamArtifact{{ID: same, Team: c.team}}
		h.attachSeriesVersions(rows, c.project)
		assert.Equal(t, c.want, [2]int{rows[0].Version, rows[0].Versions}, "project %q team %q", c.project, c.team)
	}
}

// #13988: an all-teams row follows its board's ID, never its display label. A board whose label differs from its id ("Product" for alpha) lost its version, its series id and its opened version on the cross-team
// list, because the series was looked up under the label; a team's own list (a project given) is unchanged.
func TestAnAllTeamsRowOfALabelledBoardCarriesItsSeriesFacts(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	ctx := context.Background()
	b := struct{ ID, Label string }{"alpha", "Product"} // the rig's team is alpha: its label is Product
	require.NoError(t, k.h.bs.RenameBoard(ctx, b.ID, b.Label))
	root, err := k.h.bs.CreateTask(ctx, b.ID, "OPERATOR the document", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	var d []string
	for _, body := range []string{"the document, version one", "the document, version two", "the document, version three"} {
		code, out := k.upTask("s1", root.ID, body, "&name=doc.md")
		require.Equal(t, 201, code, out)
		d = append(d, digestOfURI(out["uri"].(string)))
	}
	code, list := p.get(t, "/api/team-artifacts?tag=for+review&team="+b.ID, nil)
	require.Equal(t, 200, code, list)
	arts, _ := list["artifacts"].([]any)
	require.NotEmpty(t, arts, list)
	row := arts[0].(map[string]any)
	assert.Equal(t, b.ID, row["board_id"])
	assert.Equal(t, "Product", row["team"], "the label is for display")
	assert.EqualValues(t, 3, row["version"], "the row's own version")
	assert.EqualValues(t, 3, row["versions"])
	assert.NotEmpty(t, row["series_id"], "the series the row belongs to")
	// the opened version (#13959) of a labelled board
	req := httptest.NewRequest(http.MethodPost, "/api/artifacts/"+d[1]+"/opened", nil)
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", d[1])
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	rec := httptest.NewRecorder()
	k.h.openedArtifactRoute(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	_, list = p.get(t, "/api/team-artifacts?tag=for+review&team="+b.ID, nil)
	row = list["artifacts"].([]any)[0].(map[string]any)
	assert.EqualValues(t, 2, row["opened_version"], "what the Operator opened, on the labelled board's row")
	// the team's own list keeps its version
	_, own := p.get(t, "/api/board/"+b.ID+"/artifacts?tag=for+review", nil)
	oa, _ := own["artifacts"].([]any)
	require.NotEmpty(t, oa, own)
	assert.EqualValues(t, 3, oa[0].(map[string]any)["version"])

}

// #14145: every row carries the file's stable id and the one version line, in a series or not, and the same line the upload and the viewer use; a different team's identical bytes are a different file.
func TestTeamArtifactRowsCarryTheFileIdAndTheVersionLine(t *testing.T) {
	rig, _ := ownerRig(t)
	_, d := seriesOf(t, rig) // three versions of plan.txt
	solo := rig.uploadText("a1", "solo.txt", "no second version")
	h := &BoardHandler{coralDir: rig.coralDir}
	rows := []teamArtifact{{ID: d[0], Name: "plan.txt"}, {ID: d[2], Name: "plan.txt"}, {ID: solo, Name: "solo.txt"}, {ID: "task-link-without-a-stored-object"}}
	h.attachSeriesVersions(rows, "team-a")
	sid, _, ok := digestSeriesOnBoard(rig.coralDir, d[0], "team-a")
	require.True(t, ok)
	assert.Equal(t, sid, rows[0].FileID)
	assert.Equal(t, "version 1 of plan.txt (file "+sid+")", rows[0].VersionLine)
	assert.Equal(t, sid, rows[1].FileID, "every version of a file has its id")
	assert.Equal(t, "version 3 of plan.txt (file "+sid+")", rows[1].VersionLine)
	assert.Equal(t, virtualFileID("team-a", solo), rows[2].FileID, "a file never versioned: its derived id, version 1")
	assert.Equal(t, "version 1 of solo.txt (file "+virtualFileID("team-a", solo)+")", rows[2].VersionLine)
	assert.NotEqual(t, virtualFileID("team-b", solo), rows[2].FileID, "another team's identical bytes are another file")
	// the id the row shows is the id the first version of it keeps
	code, out := rig.uploadVersion("a1", "solo.txt", "second", "coral://artifacts/"+solo)
	require.Equal(t, 201, code, out)
	assert.Equal(t, rows[2].FileID, out["file_id"], "the id shown before it was versioned is the id it keeps")
	// a store with no series still gives the derived id
	empty := &BoardHandler{coralDir: t.TempDir()}
	none := []teamArtifact{{ID: solo, Name: "solo.txt"}}
	empty.attachSeriesVersions(none, "team-a")
	assert.Equal(t, virtualFileID("team-a", solo), none[0].FileID)
}
