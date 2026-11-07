package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14214, QA's four guards on #14145 commit 1: each is a rule a code comment promises, and each has a test that fails against its own mutant.

// (1) The server's own join of a task chain is one file per chain, not per file name (#12144): it never refuses on a name. Only an upload that NAMED its file (--new-version-of) is checked.
func TestATaskChainJoinNeverRefusesOnAFileName(t *testing.T) {
	k := newKindRig(t)
	ctx := t.Context()
	root, err := k.h.bs.CreateTask(ctx, "alpha", "OPERATOR the plan", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	code, out := k.upTask("s1", root.ID, "plan, version one", "")
	require.Equal(t, 201, code, out)
	sid := fmt.Sprint(out["file_id"]) // a first upload has no series yet: its file id is the one the series will have
	require.Regexp(t, fileIDRe, sid)
	// the same agent's next upload for the task, under ANOTHER name, and with no --new-version-of: it joins the chain's file, as before the name rule
	code, out = k.post("s1&tag=for+review&question=Does+it+work%3F", "plan, version two", map[string]string{"X-Artifact-Task": strconv.FormatInt(root.ID, 10), "X-Artifact-Name": "plan-renamed.md"})
	assert.Equal(t, http.StatusCreated, code, "a chain join is never refused for a name: %v", out)
	assert.EqualValues(t, 2, out["version"], "it joined the chain's file")
	assert.Equal(t, sid, fmt.Sprint(out["series_id"]))
	// the same name change on an upload that NAMED its file is refused (the rule is for the agent's own word, not for the server's join)
	code, out = k.post("s1&tag=for+review&question=Does+it+work%3F", "plan, version three", map[string]string{"X-Artifact-Task": strconv.FormatInt(root.ID, 10), "X-Artifact-Name": "yet-another.md", "X-Artifact-New-Version-Of": sid + "@2"})
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Equal(t, "name_differs", out["code"])
}

// (2) A bare file id is a good base only when the newest version is the caller's own AND no person made it: the #13792 guard that stops an agent building over the Operator's editor save. The newest version here
// is by the same uploader, but its server-side record says the Operator's editor made it.
func TestABareFileIdIsNotABaseWhenAPersonSavedTheNewestEvenUnderTheCallersName(t *testing.T) {
	rig, _ := ownerRig(t)
	v1 := rig.uploadText("a1", "plan.txt", "plan, first draft")
	code, out := rig.uploadVersion("a1", "plan.txt", "plan, second draft", "coral://artifacts/"+v1)
	require.Equal(t, http.StatusCreated, code, out)
	sid := fmt.Sprint(out["file_id"])
	v2 := rig.digestOf(out)
	path := filepath.Join(rig.coralDir, "artifacts", "uploads", "a1", v2+".json")
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	var rec agentUploadRecord
	require.NoError(t, json.Unmarshal(b, &rec))
	rec.Source = sourceOperatorEdit // a person's save, with the uploader left as a1's name: only the server's own Source says it
	b, err = json.Marshal(rec)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, b, 0o600))
	before := len(seriesMembersFor(rig, v1))
	code, out = rig.uploadNamed("a1", "plan.txt", "plan, third draft built over the person's save", sid, false)
	assert.Equal(t, http.StatusConflict, code, "a bare id never builds over a person's version: %v", out)
	assert.Equal(t, "stale_base", out["code"])
	assert.Equal(t, true, out["latest_by_person"])
	assert.Equal(t, before, len(seriesMembersFor(rig, v1)), "nothing was stored")
	// naming the version it read is the way through
	code, out = rig.uploadNamed("a1", "plan.txt", "plan, third draft, from the person's version", sid+"@2", false)
	assert.Equal(t, http.StatusCreated, code, "%v", out)
}

// (3) The derived file id includes the board: another team's file with the same bytes is another id, and neither team can use the other's id.
func TestTheDerivedFileIdNamesTheBoardSoAnotherTeamsIdenticalFileIsNotTheSameFile(t *testing.T) {
	assert.NotEqual(t, virtualFileID("team-a", "d1"), virtualFileID("team-b", "d1"), "the same bytes on two boards")
	assert.NotEqual(t, virtualFileID("team-a", "d1"), virtualFileID("team-a", "d2"), "two files on one board")
	assert.Equal(t, virtualFileID("team-a", "d1"), virtualFileID("team-a", "d1"), "and stable")
	assert.Regexp(t, fileIDRe, virtualFileID("team-a", "d1"))

	rig, _ := ownerRig(t)
	_, a := rig.uploadNamed("a1", "plan.txt", "the same bytes", "", false)
	_, b := rig.uploadNamed("b1", "plan.txt", "the same bytes", "", false)
	require.Equal(t, rig.digestOf(a), rig.digestOf(b), "one digest, two teams' records")
	assert.NotEqual(t, a["file_id"], b["file_id"])
	// team-b cannot add a version to team-a's file by its id, and the refusal is the same as for an id that does not exist
	code, out := rig.uploadNamed("b1", "plan.txt", "team b, second", fmt.Sprint(a["file_id"]), false)
	assert.Equal(t, http.StatusNotFound, code, "%v", out)
	assert.Equal(t, "series_not_found", out["code"])
	code, out = rig.uploadNamed("b1", "plan.txt", "team b, second", fmt.Sprint(b["file_id"]), false)
	assert.Equal(t, http.StatusCreated, code, "its own id works: %v", out)
}

// (4) A file never versioned is found by its derived id only while its bytes are in no series: when another record of the same bytes is in a series, that series is the file, and a bare record of the bytes is not
// a second "version 1" in front of it. The walk meets the unstamped record first here (session a1 sorts before a2).
func TestAnUnstampedRecordOfBytesAlreadyInASeriesIsNotAVersionOneOfItsOwn(t *testing.T) {
	rig, _ := ownerRig(t)
	same := rig.uploadText("a2", "plan.txt", "the same first draft") // a2's record becomes version 1 of the series
	code, out := rig.uploadVersion("a2", "plan.txt", "second draft", "coral://artifacts/"+same)
	require.Equal(t, http.StatusCreated, code, out)
	sid := fmt.Sprint(out["file_id"])
	require.Equal(t, same, rig.uploadText("a1", "plan.txt", "the same first draft"), "a1 uploads the same bytes: an unstamped record, visited before a2's")
	require.NoError(t, os.Remove(seriesPath(rig.coralDir, sid)), "the index is gone (a lost or damaged one is found by the walk of the records, which is where a bare record could be mistaken for a file)")
	members := membersOfSeries(rig.coralDir, sid, true)
	require.Len(t, members, 2, "the series has its two versions, whatever record the walk meets first")
	for _, m := range members {
		assert.False(t, m.Virtual, "no derived 'version 1' stands in front of the real one (version %d)", m.N)
	}
	assert.Equal(t, []int{1, 2}, []int{members[0].N, members[1].N})
	assert.Equal(t, "a2", members[0].Session, "version 1 is the series' own record, not the later bare one")
}
