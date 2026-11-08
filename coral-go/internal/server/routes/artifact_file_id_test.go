package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14145: a file has a stable id (its series id, or one derived while it was never versioned) and each version a number; a new version names the file by that id, and a different name is refused
// unless the agent says it is a rename.

var fileIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

func (rig *artifactRig) uploadNamed(session, name, text, ref string, rename bool) (int, map[string]any) {
	req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id="+session, strings.NewReader(text))
	require.NoError(rig.t, err)
	req.Header.Set("X-Artifact-Name", name)
	req.Header.Set("X-Artifact-Media-Type", "text/plain")
	if ref != "" {
		req.Header.Set(seriesHeader, ref)
	}
	if rename {
		req.Header.Set("X-Artifact-Rename", "1")
	}
	resp, err := agentClient.Do(req)
	require.NoError(rig.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestEveryUploadSaysItsFileIdAndVersionAndTheIdDoesNotChangeWhenItIsVersioned(t *testing.T) {
	rig, _ := ownerRig(t)
	code, first := rig.uploadNamed("a1", "plan.txt", "plan v1", "", false)
	require.Equal(t, http.StatusCreated, code, first)
	id := fmt.Sprint(first["file_id"])
	assert.Regexp(t, fileIDRe, id, "a file that was never versioned has an id from its first upload")
	assert.EqualValues(t, 1, first["version"])
	assert.Equal(t, "version 1 of plan.txt (file "+id+")", first["version_line"])

	code, second := rig.uploadNamed("a1", "plan.txt", "plan v2", "coral://artifacts/"+rig.digestOf(first), false)
	require.Equal(t, http.StatusCreated, code, second)
	assert.Equal(t, id, second["file_id"], "the id shown before it was versioned is the id it keeps")
	assert.Equal(t, id, second["series_id"], "series_id is the same id, for old scripts")
	assert.EqualValues(t, 2, second["version"])
	assert.Equal(t, "version 2 of plan.txt (file "+id+")", second["version_line"])
	// the id of another team's identical file is not this id
	code, other := rig.uploadNamed("b1", "plan.txt", "plan v1", "", false)
	require.Equal(t, http.StatusCreated, code, other)
	assert.NotEqual(t, id, other["file_id"])
}

func TestANewVersionByFileIdWorksAndTheDigestWayStillDoes(t *testing.T) {
	rig, _ := ownerRig(t)
	_, first := rig.uploadNamed("a1", "plan.txt", "plan v1", "", false)
	id := fmt.Sprint(first["file_id"])
	// the file id of a file never versioned: the first new version by its id
	code, v2 := rig.uploadNamed("a1", "plan.txt", "plan v2", id, false)
	assert.Equal(t, http.StatusCreated, code, "%v", v2)
	assert.Equal(t, id, v2["file_id"])
	assert.EqualValues(t, 2, v2["version"])
	// <id>@<n> names the version edited: the newest is the base
	code, v3 := rig.uploadNamed("a1", "plan.txt", "plan v3", id+"@2", false)
	assert.Equal(t, http.StatusCreated, code, "%v", v3)
	assert.EqualValues(t, 3, v3["version"])
	// an old digest link still works for a script, from the newest version
	code, v4 := rig.uploadNamed("a1", "plan.txt", "plan v4", "coral://artifacts/"+rig.digestOf(v3), false)
	assert.Equal(t, http.StatusCreated, code, "%v", v4)
	assert.Equal(t, id, v4["file_id"], "its reply names the file id to use")
	// a version that is not there, and a malformed @n, are refused before anything is stored
	code, out := rig.uploadNamed("a1", "plan.txt", "plan v5", id+"@9", false)
	assert.Equal(t, http.StatusNotFound, code, "%v", out)
	assert.Equal(t, "version_not_found", out["code"])
	for _, bad := range []string{id + "@0", id + "@", id + "@x", id + "@1000", id + "@-1", id + "@2@3"} {
		code, out = rig.uploadNamed("a1", "plan.txt", "plan v5", bad, false)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", bad, out)
	}
	assert.Len(t, seriesMembersFor(rig, rig.digestOf(first)), 4, "nothing was stored by a refusal")
}

func TestABareFileIdIsABaseOnlyWhenTheNewestVersionIsTheCallersOwn(t *testing.T) {
	rig, _ := ownerRig(t)
	_, first := rig.uploadNamed("a1", "plan.txt", "plan v1", "", false)
	id := fmt.Sprint(first["file_id"])
	code, v2 := rig.uploadNamed("a2", "plan.txt", "plan v2 by a2", "coral://artifacts/"+rig.digestOf(first), false)
	require.Equal(t, http.StatusCreated, code, v2)
	// a1's bare id: the newest is a2's, so it is refused as a stale base, and told the id@n to use (#13792 stays)
	code, out := rig.uploadNamed("a1", "plan.txt", "plan v3 by a1", id, false)
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "stale_base", out["code"])
	assert.Contains(t, out["error"], "--new-version-of <file id>@2")
	// a2's bare id: the newest is its own
	code, out = rig.uploadNamed("a2", "plan.txt", "plan v3 by a2", id, false)
	assert.Equal(t, http.StatusCreated, code, "%v", out)
	// a1 naming the version it edited (the newest, now 3) works; naming 1 is stale
	code, out = rig.uploadNamed("a1", "plan.txt", "plan v4 by a1", id+"@1", false)
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	code, out = rig.uploadNamed("a1", "plan.txt", "plan v4 by a1", id+"@3", false)
	assert.Equal(t, http.StatusCreated, code, "%v", out)
}

func TestANewVersionUnderAnotherNameIsRefusedUnlessItIsARename(t *testing.T) {
	rig, _ := ownerRig(t)
	_, first := rig.uploadNamed("a1", "coral-resource-queue-active.png", "image one", "", false)
	id := fmt.Sprint(first["file_id"])
	before := len(seriesMembersFor(rig, rig.digestOf(first)))
	for _, ref := range []string{id, id + "@1", "coral://artifacts/" + rig.digestOf(first)} {
		code, out := rig.uploadNamed("a1", "coral-resource-queue-agent-view.png", "a different picture", ref, false)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", ref, out)
		assert.Equal(t, "name_differs", out["code"])
		assert.Contains(t, out["error"], "coral-resource-queue-active.png", "it names the file's name")
		assert.Contains(t, out["error"], "coral-resource-queue-agent-view.png", "and the upload's")
		assert.Contains(t, out["error"], id, "and the file")
		assert.Contains(t, out["error"], "--rename")
	}
	assert.Equal(t, before, len(seriesMembersFor(rig, rig.digestOf(first))), "nothing was stored")
	// the same name is fine, and a rename is allowed when asked for
	code, out := rig.uploadNamed("a1", "coral-resource-queue-active.png", "image two", id, false)
	assert.Equal(t, http.StatusCreated, code, "%v", out)
	code, out = rig.uploadNamed("a1", "queue.png", "image three", id+"@2", true)
	assert.Equal(t, http.StatusCreated, code, "%v", out)
	assert.Equal(t, "version 3 of queue.png (file "+id+")", out["version_line"])
	// the new name is the file's name from now on
	code, out = rig.uploadNamed("a1", "other.png", "image four", id+"@3", false)
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Contains(t, out["error"], `"queue.png"`)
}

func TestFileIdsOfOtherTeamsAndUnknownIdsLookLikeNothing(t *testing.T) {
	rig, _ := ownerRig(t)
	_, first := rig.uploadNamed("a1", "plan.txt", "plan v1", "", false)
	id := fmt.Sprint(first["file_id"])
	code, out := rig.uploadNamed("b1", "plan.txt", "plan v2 by another team", id, false)
	assert.Equal(t, http.StatusNotFound, code, "%v", out)
	assert.Equal(t, "series_not_found", out["code"])
	code, out = rig.uploadNamed("a1", "plan.txt", "x", strings.Repeat("0", 32), false)
	assert.Equal(t, http.StatusNotFound, code, "%v", out)
	assert.Equal(t, "series_not_found", out["code"], "an unknown id and another team's are told apart by nothing")
}
