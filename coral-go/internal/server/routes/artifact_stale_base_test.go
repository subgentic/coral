package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13792: an agent's new version names the version it edited (the digest in --new-version-of); the server compares it with the newest under the series lock. A version a person made after it is never
// buried, and neither is another agent's: the Operator's decision is to refuse at once, whoever made the newer version.

// asPerson turns the upload record of digest (uploaded by session) into one the server would have written for the Operator's editor save: the fields only the server sets.
func (rig *artifactRig) asPerson(session, digest string) {
	rig.t.Helper()
	path := filepath.Join(rig.coralDir, "artifacts", "uploads", session, digest+".json")
	b, err := os.ReadFile(path)
	require.NoError(rig.t, err)
	var rec agentUploadRecord
	require.NoError(rig.t, json.Unmarshal(b, &rec))
	rec.Uploader, rec.Role, rec.UploadedBy, rec.Source = board.OperatorName, "operator", "owner", sourceOperatorEdit
	b, err = json.Marshal(rec)
	require.NoError(rig.t, err)
	require.NoError(rig.t, os.WriteFile(path, b, 0o600))
}

func (rig *artifactRig) digestOf(out map[string]any) string {
	rig.t.Helper()
	return strings.TrimPrefix(fmt.Sprint(out["uri"]), "coral://artifacts/")
}

// personSeries is v1 (a1), v2 (a1) made as the Operator's save.
func personSeries(t *testing.T, rig *artifactRig) (v1, v2 string) {
	t.Helper()
	v1 = rig.uploadText("a1", "plan.txt", "plan, first draft")
	code, out := rig.uploadVersion("a1", "plan.txt", "plan, the Operator's words", "coral://artifacts/"+v1)
	require.Equal(t, http.StatusCreated, code, out)
	v2 = rig.digestOf(out)
	rig.asPerson("a1", v2)
	return v1, v2
}

func TestAnAgentCannotUploadOverAPersonsNewerVersion(t *testing.T) {
	rig, _ := ownerRig(t)
	v1, v2 := personSeries(t, rig)
	before := len(seriesMembersFor(rig, v1))
	code, out := rig.uploadVersion("a1", "plan.txt", "an agent's older copy, edited", "coral://artifacts/"+v1)
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "stale_base", out["code"])
	assert.Equal(t, v2, out["latest_digest"])
	assert.EqualValues(t, 2, out["latest_version"])
	assert.Equal(t, true, out["latest_by_person"])
	assert.Equal(t, "coral://artifacts/"+v2, out["uri"])
	assert.Contains(t, out["error"], "coral-agent artifact download coral://artifacts/"+v2, "the sentence names the download line")
	assert.Contains(t, out["error"], "--new-version-of coral://artifacts/"+v2, "and the link to upload with")
	assert.NotContains(t, fmt.Sprint(out), "the Operator's words", "no text of the file")
	assert.Equal(t, before, len(seriesMembersFor(rig, v1)), "nothing was stored: the person's version is still the newest")
	// editing the newest is the way through
	code, out = rig.uploadVersion("a1", "plan.txt", "the person's words, plus the agent's", "coral://artifacts/"+v2)
	assert.Equal(t, http.StatusCreated, code, "%v", out)
}

func TestAnotherAgentsNewerVersionIsNotBuriedEither(t *testing.T) {
	rig, _ := ownerRig(t)
	v1 := rig.uploadText("a1", "plan.txt", "plan, first draft")
	code, out := rig.uploadVersion("a2", "plan.txt", "plan, second draft by a2", "coral://artifacts/"+v1)
	require.Equal(t, http.StatusCreated, code, out)
	v2 := rig.digestOf(out)
	before := len(seriesMembersFor(rig, v1))
	code, out = rig.uploadVersion("a1", "plan.txt", "plan, a1 from the first draft", "coral://artifacts/"+v1)
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "stale_base", out["code"])
	assert.Equal(t, v2, out["latest_digest"])
	assert.Equal(t, false, out["latest_by_person"])
	assert.Equal(t, before, len(seriesMembersFor(rig, v1)), "nothing stored")
}

func TestASeriesLinkNamesNoVersionAndIsRefusedAsANewVersion(t *testing.T) {
	rig, _ := ownerRig(t)
	v1 := rig.uploadText("a1", "plan.txt", "plan, first draft")
	code, out := rig.uploadVersion("a1", "plan.txt", "plan, second", "coral://artifacts/"+v1)
	require.Equal(t, http.StatusCreated, code, out)
	sid, _ := out["series_id"].(string)
	v2 := rig.digestOf(out)
	for _, who := range []string{"a1", "a2"} {
		code, out = rig.uploadVersion(who, "plan.txt", "plan, by the series link of "+who, "coral://artifacts/series/"+sid)
		assert.Equal(t, http.StatusConflict, code, "%s: %v", who, out)
		assert.Equal(t, "stale_base", out["code"])
		assert.Contains(t, out["error"], "A series link names no version")
		assert.Contains(t, out["error"], "--new-version-of coral://artifacts/"+v2)
	}
	assert.Len(t, seriesMembersFor(rig, v1), 2)
	// a first upload that is a version of nothing stays allowed
	assert.NotEmpty(t, rig.uploadText("a1", "other.txt", "a different file"))
}

func TestTwoAgentsFromTheSameBaseAreOneWinnerOneRefusal(t *testing.T) {
	rig, _ := ownerRig(t)
	v1 := rig.uploadText("a1", "plan.txt", "plan, first draft")
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, who := range []string{"a1", "a2"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i], _ = rig.uploadVersion(who, "plan.txt", "draft by "+who, "coral://artifacts/"+v1)
		}()
	}
	wg.Wait()
	assert.ElementsMatch(t, []int{http.StatusCreated, http.StatusConflict}, codes, "one wins")
	assert.Len(t, seriesMembersFor(rig, v1), 2, "the first version and the winner")
}

func TestTheNewestAsTheBaseIsNeverStale(t *testing.T) {
	rig, _ := ownerRig(t)
	v1 := rig.uploadText("a1", "plan.txt", "plan, first draft")
	code, out := rig.uploadVersion("a1", "plan.txt", "plan, second", "coral://artifacts/"+v1)
	require.Equal(t, http.StatusCreated, code, out)
	code, out = rig.uploadVersion("a1", "plan.txt", "plan, third", "coral://artifacts/"+rig.digestOf(out))
	assert.Equal(t, http.StatusCreated, code, out)
}

func seriesMembersFor(rig *artifactRig, digest string) []seriesMember {
	sid, _, in := digestSeries(rig.coralDir, digest)
	if !in {
		return nil
	}
	return seriesMembers(rig.coralDir, sid)
}
