package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

func vrow(id, name, at, session, by string) teamArtifact {
	row := teamArtifact{ID: id, Name: name, CreatedAt: at, BoardID: "b-1", managed: "m-" + id}
	if session != "" {
		row.SessionID = &session
	}
	if by != "" {
		row.ProducedBy = &by
	}
	return row
}

func idsOf(rows []teamArtifact) []string {
	var out []string
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out
}

// The versions of an artifact (same team, uploader and name) are one row, the newest, with a count of the earlier ones (#11700, as Needs you does for #11533).
func TestCollapseVersionsKeepsTheNewestOfAnUploadersFile(t *testing.T) {
	rows := []teamArtifact{
		vrow("a1", "design.png", "2026-10-31T10:00:00Z", "s1", "Dev"),
		vrow("a2", "design.png", "2026-10-31T11:00:00Z", "s1", "Dev"),
		vrow("a3", "design.png", "2026-10-31T12:00:00Z", "s1", "Dev"),
		vrow("b1", "other.png", "2026-10-31T09:00:00Z", "s1", "Dev"),
	}
	got := collapseVersions(rows)
	assert.Equal(t, []string{"a3", "b1"}, idsOf(got), "the newest version stands for the file, in the list's order of first appearance by newest")
	assert.Equal(t, 2, got[0].EarlierVersions)
	assert.Equal(t, 0, got[1].EarlierVersions)
	assert.Len(t, rows, 4, "the input is not changed")
}

func TestCollapseVersionsNeverMergesWhatIsNotOneUploadersFile(t *testing.T) {
	rows := []teamArtifact{
		vrow("1", "x.png", "2026-10-31T10:00:00Z", "s1", "Dev"),
		vrow("2", "x.png", "2026-10-31T11:00:00Z", "s2", "Dev"), // another session
		vrow("3", "x.png", "2026-10-31T12:00:00Z", "s1", "QA"),  // another producer
		vrow("4", "x.png", "2026-10-31T13:00:00Z", "", ""),      // no uploader: its own row
		vrow("5", "x.png", "2026-10-31T14:00:00Z", "", ""),
		vrow("6", "|", "2026-10-31T15:00:00Z", "s1|", "Dev"), // a '|' in a name can't join two keys
		vrow("7", "", "2026-10-31T16:00:00Z", "s1", "Dev|"),
	}
	other := vrow("8", "x.png", "2026-10-31T17:00:00Z", "s1", "Dev")
	other.BoardID = "b-2" // another team
	rows = append(rows, other)
	noObj := vrow("9", "x.png", "2026-10-31T18:00:00Z", "s1", "Dev")
	noObj.managed = "" // a link, not an upload
	rows = append(rows, noObj)
	digest := vrow("10", "sha256:"+"a1b2c3d4e5f60718293a4b5c6d7e8f90", "2026-10-31T19:00:00Z", "s1", "Dev")
	digest2 := vrow("11", "sha256:"+"a1b2c3d4e5f60718293a4b5c6d7e8f90", "2026-10-31T20:00:00Z", "s1", "Dev")
	rows = append(rows, digest, digest2)
	got := collapseVersions(rows)
	assert.Len(t, got, len(rows), "none of these are versions of one another: %v", idsOf(got))
	for _, r := range got {
		assert.Zero(t, r.EarlierVersions, r.ID)
	}
}

// The Tag filter's counts and the For review pill count files, not versions: a file counts once for a tag any of its versions carries.
func TestTagCountsOfVersionsCountFiles(t *testing.T) {
	a1 := vrow("a1", "d.png", "2026-10-31T10:00:00Z", "s1", "Dev")
	a1.Tags = []string{"for review", "design"}
	a2 := vrow("a2", "d.png", "2026-10-31T11:00:00Z", "s1", "Dev")
	a2.Tags = []string{"for review"}
	b := vrow("b", "e.png", "2026-10-31T12:00:00Z", "s1", "Dev")
	b.Tags = []string{"for review"}
	assert.Equal(t, map[string]int{"for review": 3, "design": 1}, teamTagCounts([]teamArtifact{a1, a2, b}), "versions, as before")
	assert.Equal(t, map[string]int{"for review": 2, "design": 1}, teamTagCountsByFile([]teamArtifact{a1, a2, b}))
}

// End to end: three uploads of one file name and one of another by the same agent are 4 rows as before, and with versions=newest 2 rows, whose total, all and tag counts count files (#11700).
func TestTeamArtifactsListWithVersionsNewestCountsFiles(t *testing.T) {
	e := newTagEnv(t) // report.md, scratch.log and final.pdf, each once
	versionIDs := []string{e.ids["report.md"]}
	for _, text := range []string{"report v2", "report v3"} {
		id := storeManagedArtifact(t, e.coralDir, text, true, true)
		completeWithArtifacts(t, e.h, "tag-team", "Report again "+text, []board.TaskArtifact{{Name: "report.md", URI: "coral://artifacts/" + id}})
		versionIDs = append(versionIDs, id)
	}
	// every version of report.md, and one other file, are tagged for review: 4 tagged versions, 2 tagged files
	for _, id := range append(versionIDs, e.ids["final.pdf"]) {
		code, _ := e.put(t, "tag-team", id, `{"tags":["for review"]}`)
		require.Equal(t, 200, code)
	}
	plain := e.list(t, "limit=50", 200)
	assert.Equal(t, 5, len(plain["artifacts"].([]any)), "no versions parameter: every version, as before")
	assert.Nil(t, plain["artifacts"].([]any)[0].(map[string]any)["earlier_versions"])

	all := e.list(t, "limit=50&sort=newest", 200)
	versioned := e.list(t, "limit=50&versions=newest", 200)
	rows := versioned["artifacts"].([]any)
	assert.Equal(t, len(all["artifacts"].([]any))-2, len(rows), "the two older report.md versions are folded: %v", namesOf(versioned))
	assert.Equal(t, float64(len(rows)), versioned["total"])
	assert.Equal(t, float64(len(rows)), versioned["all"])
	var earlier float64
	for _, r := range rows {
		if m := r.(map[string]any); m["name"] == "report.md" {
			earlier, _ = m["earlier_versions"].(float64)
		}
	}
	assert.Equal(t, float64(2), earlier, "the newest report.md says how many it stands for")
	assert.Equal(t, map[string]any{"for review": float64(2)}, versioned["tag_counts"], "files, not versions: report.md's three tagged versions are one file")
	assert.Equal(t, map[string]any{"for review": float64(4)}, all["tag_counts"], "without versions=newest the counts are of versions, as before")
	review := e.list(t, "limit=50&versions=newest&tag=for%20review", 200)
	assert.Equal(t, float64(2), review["total"], "the For review pill and its list agree: two files")
	e.list(t, "versions=bogus", 400)
}
