package routes

import (
	"testing"

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
