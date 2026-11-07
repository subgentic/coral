package routes

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

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

// #14086 (a v2.0.59 blocker): the collapsed row of a legacy file (same team, uploader and name, no series) carries the older versions' digests, oldest first, so a decision on the newest settles them.
func TestCollapseVersionsCarriesTheEarlierDigestsOldestFirst(t *testing.T) {
	rows := []teamArtifact{
		vrow("a3", "design.png", "2026-10-31T12:00:00Z", "s1", "Dev"),
		vrow("a1", "design.png", "2026-10-31T10:00:00Z", "s1", "Dev"),
		vrow("a2", "design.png", "2026-10-31T11:00:00Z", "s1", "Dev"),
		vrow("b1", "other.png", "2026-10-31T09:00:00Z", "s1", "Dev"),
		vrow("c1", "design.png", "2026-10-31T13:00:00Z", "s2", "Dev"), // another session: another file
	}
	got := collapseVersions(rows)
	byID := map[string]teamArtifact{}
	for _, r := range got {
		byID[r.ID] = r
	}
	assert.Equal(t, []string{"m-a1", "m-a2"}, byID["a3"].EarlierDigests, "the earlier versions of this file, oldest first, whatever order the rows came in")
	assert.Equal(t, 2, byID["a3"].EarlierVersions)
	assert.Empty(t, byID["b1"].EarlierDigests, "a file with one version has none")
	assert.Empty(t, byID["c1"].EarlierDigests, "another session's file is not this one's version")
	assert.NotContains(t, byID["a3"].EarlierDigests, "m-c1", "never another uploader's digest")
	for _, r := range rows {
		assert.Empty(t, r.EarlierDigests, "the input is not changed")
	}
}

// A link (no object), a row with no uploader and a row named by its digest are nobody's version, so they never carry or lend a digest.
func TestCollapseVersionsLendsNoDigestOfWhatIsNotAnUploadersFile(t *testing.T) {
	a := vrow("1", "x.png", "2026-10-31T10:00:00Z", "s1", "Dev")
	link := vrow("2", "x.png", "2026-10-31T11:00:00Z", "s1", "Dev")
	link.managed = ""
	other := vrow("3", "x.png", "2026-10-31T12:00:00Z", "s1", "Dev")
	other.BoardID = "b-2"
	got := collapseVersions([]teamArtifact{a, link, other})
	for _, r := range got {
		assert.Empty(t, r.EarlierDigests, r.ID)
	}
}

// The overflow contract: at most maxEarlierDigests digests (the oldest), EarlierVersions the whole count; once those are settled (they leave the list) the next read carries the next oldest, until none are left.
func TestTheEarlierDigestsAreCappedAndTheRestFollowOnceTheseAreSettled(t *testing.T) {
	var rows []teamArtifact
	for i := 0; i < maxEarlierDigests+3; i++ { // 53 versions: the newest and 52 older
		rows = append(rows, vrow(fmt.Sprintf("v%03d", i), "big.zip", fmt.Sprintf("2026-10-31T10:%02d:%02dZ", i/60, i%60), "s1", "Dev"))
	}
	got := collapseVersions(rows)
	require.Len(t, got, 1)
	assert.Equal(t, 52, got[0].EarlierVersions, "the whole count")
	require.Len(t, got[0].EarlierDigests, maxEarlierDigests, "capped")
	assert.Equal(t, "m-v000", got[0].EarlierDigests[0], "the oldest first")
	assert.Equal(t, fmt.Sprintf("m-v%03d", maxEarlierDigests-1), got[0].EarlierDigests[maxEarlierDigests-1])
	assert.Greater(t, got[0].EarlierVersions, len(got[0].EarlierDigests), "more than it carries: read again after settling")
	// the client settles those: they leave the list
	settled := map[string]bool{}
	for _, d := range got[0].EarlierDigests {
		settled[d] = true
	}
	var left []teamArtifact
	for _, r := range rows {
		if !settled[r.managed] {
			left = append(left, r)
		}
	}
	again := collapseVersions(left)
	require.Len(t, again, 1)
	assert.Equal(t, 2, again[0].EarlierVersions)
	assert.Equal(t, []string{"m-v050", "m-v051"}, again[0].EarlierDigests, "the next oldest")
	assert.Equal(t, "v052", again[0].ID, "still the same newest")
}

// End to end, as the Inbox reads it: the newest report.md carries its two older versions' digests, oldest first, on the list the Inbox uses (tag=for review&versions=newest).
func TestTheForReviewListCarriesTheEarlierDigestsOfALegacyFile(t *testing.T) {
	e := newTagEnv(t)
	versionIDs := []string{e.ids["report.md"]}
	for _, text := range []string{"report v2", "report v3"} {
		id := storeManagedArtifact(t, e.coralDir, text, true, true)
		completeWithArtifacts(t, e.h, "tag-team", "Report again "+text, []board.TaskArtifact{{Name: "report.md", URI: "coral://artifacts/" + id}})
		versionIDs = append(versionIDs, id)
	}
	for _, id := range append(versionIDs, e.ids["final.pdf"]) {
		code, _ := e.put(t, "tag-team", id, `{"tags":["for review"]}`)
		require.Equal(t, 200, code)
	}
	review := e.list(t, "limit=50&versions=newest&tag=for%20review", 200)
	var row map[string]any
	for _, r := range review["artifacts"].([]any) {
		if m := r.(map[string]any); m["name"] == "report.md" {
			row = m
		}
	}
	require.NotNil(t, row)
	assert.Equal(t, float64(2), row["earlier_versions"])
	got, _ := row["earlier_digests"].([]any)
	require.Len(t, got, 2, "%v", row)
	// which upload is the newest is the list's own order (the uploads of this test share a second, so the tie goes by row id): the row says which it is by its own digest, and the other two are its earlier versions
	own := strings.TrimPrefix(row["digest"].(string), "sha256:")
	require.Contains(t, versionIDs, own)
	var others []string
	for _, id := range versionIDs {
		if id != own {
			others = append(others, id)
		}
	}
	assert.ElementsMatch(t, others, []string{got[0].(string), got[1].(string)}, "the other two versions of this file, never the newest's own")
	assert.NotContains(t, []string{got[0].(string), got[1].(string)}, own)
	for _, r := range review["artifacts"].([]any) {
		if m := r.(map[string]any); m["name"] == "final.pdf" {
			assert.NotContains(t, m, "earlier_digests", "a one-version file has none")
		}
	}
}

// And on the list the Inbox really reads, the cross-team one with starred_first: a legacy file (two same-name uploads by one agent, no series, never starred) carries its older version's digest, so approving the newest
// settles the older one (#14086).
func TestTheCrossTeamForReviewListCarriesTheEarlierDigestsOfAnUnstarredLegacyFile(t *testing.T) {
	_, h := setupBoardTestServer(t)
	coralDir := t.TempDir()
	h.SetTaskArtifactWriter(coralDir, nil)
	r := chi.NewRouter()
	r.Get("/api/team-artifacts", h.ListAllTeamArtifacts)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	subscribeSession(t, h, "alpha", "Alice", "00000000-0000-4000-8000-0000000000a1")
	old := storeManagedArtifact(t, coralDir, "plan, the first version", true, true)
	completeWithArtifacts(t, h, "alpha", "Plan one", []board.TaskArtifact{{Name: "plan.md", URI: "coral://artifacts/" + old}})
	newer := storeManagedArtifact(t, coralDir, "plan, the second version", true, true)
	completeWithArtifacts(t, h, "alpha", "Plan two", []board.TaskArtifact{{Name: "plan.md", URI: "coral://artifacts/" + newer}})
	other := storeManagedArtifact(t, coralDir, "a lone file", true, true)
	completeWithArtifacts(t, h, "alpha", "Lone", []board.TaskArtifact{{Name: "lone.md", URI: "coral://artifacts/" + other}})
	for _, id := range []string{old, newer, other} {
		require.NoError(t, h.bs.SetArtifactTags(context.Background(), "alpha", id, []string{"for review"}))
	}
	got := getAllTeamArtifacts(t, srv, "?tag=for+review&versions=newest&starred_first=true&limit=50", 200)
	found := false
	for _, a := range got.Artifacts {
		switch a.Name {
		case "plan.md":
			found = true
			assert.Equal(t, 1, a.EarlierVersions)
			own := strings.TrimPrefix(a.Digest, "sha256:") // the uploads share a second, so which is newest goes by row id: the row says which it is, and the other is its earlier version
			require.Contains(t, []string{old, newer}, own)
			other := old
			if own == old {
				other = newer
			}
			assert.Equal(t, []string{other}, a.EarlierDigests, "the other version's digest, so approving the newest settles it")
			assert.Empty(t, a.SeriesID, "a legacy file has no series")
		case "lone.md":
			assert.Empty(t, a.EarlierDigests)
		}
	}
	require.True(t, found, "%v", got.Artifacts)
}
