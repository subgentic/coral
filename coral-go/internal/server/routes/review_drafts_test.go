package routes

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21189 S1: a reviewer's draft comments on a document are private, per version, durable, editable and deletable, and notify no one.

func draftsPath(id string) string { return "/api/artifacts/" + id + "/review-drafts" }

func newDraft(t *testing.T, rig *cmtRig, id, body string) (int, map[string]any) {
	t.Helper()
	return rig.do(http.MethodPost, draftsPath(id), cmtAsOwner, map[string]any{"body": body, "anchor": map[string]any{"whole": true}, "board": "team"})
}

func TestADraftIsKeptPrivatelyAndNeverBecomesAPublishedComment(t *testing.T) {
	rig := newCmtRig(t)
	code, out := newDraft(t, rig, cmtDoc, "tighten section 2")
	require.Equal(t, http.StatusCreated, code, "%v", out)
	draft := out["draft"].(map[string]any)
	assert.Equal(t, "tighten section 2", draft["body"])
	assert.EqualValues(t, 1, out["revision"])

	// It is read back by the reviewer, with the flags the page needs.
	code, out = rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team", cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code)
	assert.EqualValues(t, 1, out["count"])
	assert.Equal(t, true, out["drafts_supported"])
	assert.Equal(t, true, out["can_write"])
	assert.Len(t, out["drafts"], 1)

	// It is not a comment: nobody's list of the artifact's threads holds it.
	code, out = rig.do(http.MethodGet, "/api/artifacts/"+cmtDoc+"/comments", cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, out["comments"], "a draft is not a published comment")

	// Nobody but the owner reads or writes drafts: a Hub viewer, an agent and a forged stamp are refused.
	for name, hdr := range map[string]map[string]string{"hub viewer": cmtAsHub, "agent": cmtAsAgent, "forged": cmtAsForged} {
		code, _ = rig.do(http.MethodGet, draftsPath(cmtDoc), hdr, nil)
		assert.GreaterOrEqual(t, code, 400, name)
		code, _ = rig.do(http.MethodPost, draftsPath(cmtDoc), hdr, map[string]any{"body": "x", "anchor": map[string]any{"whole": true}})
		assert.GreaterOrEqual(t, code, 400, name)
	}
	_, out = rig.do(http.MethodGet, draftsPath(cmtDoc), cmtAsOwner, nil)
	assert.EqualValues(t, 1, out["count"], "a refused caller changed nothing")
}

func TestDraftsAreOnTheVersionTheyWereWrittenOnAndCounted(t *testing.T) {
	rig := newCmtRig(t)
	for i := 0; i < 2; i++ {
		code, out := newDraft(t, rig, cmtDoc, fmt.Sprintf("note %d", i))
		require.Equal(t, http.StatusCreated, code, "%v", out)
	}
	code, out := newDraft(t, rig, cmtPic2, "other file")
	require.Equal(t, http.StatusCreated, code, "%v", out)

	_, out = rig.do(http.MethodGet, draftsPath(cmtPic2), cmtAsOwner, nil)
	assert.EqualValues(t, 1, out["count"], "another version's drafts are not here")
	code, out = rig.do(http.MethodGet, "/api/review-drafts/counts", cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code)
	got := map[string]float64{}
	for _, a := range out["artifacts"].([]any) {
		m := a.(map[string]any)
		got[m["artifact_id"].(string)] = m["count"].(float64)
	}
	assert.Equal(t, map[string]float64{cmtDoc: 2, cmtPic2: 1}, got)
}

func TestADraftEditAndDeleteNeedTheCurrentRevision(t *testing.T) {
	rig := newCmtRig(t)
	_, out := newDraft(t, rig, cmtDoc, "first")
	id := int64(out["draft"].(map[string]any)["id"].(float64))
	path := fmt.Sprintf("%s/%d", draftsPath(cmtDoc), id)

	code, out := rig.do(http.MethodPatch, path, cmtAsOwner, map[string]any{"body": "second", "revision": 1})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.EqualValues(t, 2, out["revision"])

	code, out = rig.do(http.MethodPatch, path, cmtAsOwner, map[string]any{"body": "stale", "revision": 1})
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "stale_revision", out["code"])
	assert.EqualValues(t, 2, out["revision"])
	_, out = rig.do(http.MethodGet, draftsPath(cmtDoc), cmtAsOwner, nil)
	assert.Equal(t, "second", out["drafts"].([]any)[0].(map[string]any)["body"], "a stale edit changed nothing")

	code, _ = rig.do(http.MethodPatch, path, cmtAsOwner, map[string]any{"body": "no revision"})
	assert.Equal(t, http.StatusBadRequest, code)

	code, out = rig.do(http.MethodDelete, path+"?revision=1", cmtAsOwner, nil)
	assert.Equal(t, http.StatusConflict, code, "a stale delete: %v", out)
	code, out = rig.do(http.MethodDelete, path+"?revision=2", cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.EqualValues(t, 0, out["count"])
	code, _ = rig.do(http.MethodDelete, path+"?revision=3", cmtAsOwner, nil)
	assert.Equal(t, http.StatusNotFound, code, "it is gone")
}

func TestDraftRulesAreThoseOfAComment(t *testing.T) {
	rig := newCmtRig(t)
	// A secret is not kept, as in a comment.
	code, out := newDraft(t, rig, cmtDoc, "key is ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD")
	require.Equal(t, http.StatusCreated, code)
	assert.NotContains(t, out["draft"].(map[string]any)["body"], "ghp_abcdefghijklmnopqrstuvwxyz")
	// An empty one, an anchor missing and a quote on a picture are refused.
	code, _ = newDraft(t, rig, cmtDoc, "   ")
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = rig.do(http.MethodPost, draftsPath(cmtDoc), cmtAsOwner, map[string]any{"body": "x"})
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = rig.do(http.MethodPost, draftsPath(cmtPic), cmtAsOwner, map[string]any{"body": "x", "anchor": map[string]any{"quote": "abc"}})
	assert.Equal(t, http.StatusUnsupportedMediaType, code)
	// A reply needs a published thread on this version.
	code, _ = rig.do(http.MethodPost, draftsPath(cmtDoc), cmtAsOwner, map[string]any{"body": "re", "parent_id": 999})
	assert.Equal(t, http.StatusBadRequest, code)
	parent := rig.ownerComment("a published thread")
	code, out = rig.do(http.MethodPost, draftsPath(cmtDoc), cmtAsOwner, map[string]any{"body": "re", "parent_id": parent})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	// Locked comments take no draft.
	code, _ = rig.do(http.MethodPut, "/api/artifacts/"+cmtDoc+"/comments/lock", cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code)
	code, out = newDraft(t, rig, cmtDoc, "late")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "comments_locked", out["code"])
	_, out = rig.do(http.MethodGet, draftsPath(cmtDoc), cmtAsOwner, nil)
	assert.Equal(t, false, out["can_write"])
	assert.Equal(t, "comments_locked", out["reason"])
}

func TestAReviewerHoldsAtMostFortyDraftsOnAVersion(t *testing.T) {
	rig := newCmtRig(t)
	forgetWrites := func() { // the writes-a-minute limit is not what is tested here
		rig.h.commentLimit.mu.Lock()
		rig.h.commentLimit.seen = nil
		rig.h.commentLimit.mu.Unlock()
	}
	for i := 0; i < 40; i++ {
		forgetWrites()
		code, out := newDraft(t, rig, cmtDoc, fmt.Sprintf("draft %d", i))
		require.Equal(t, http.StatusCreated, code, "%d: %v", i, out)
	}
	forgetWrites()
	code, out := newDraft(t, rig, cmtDoc, "one too many")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "draft_limit", out["code"])
}

func TestGoalAndDiffSubjectsTakeNoDrafts(t *testing.T) {
	rig := newCmtRig(t)
	for _, id := range []string{"goal:team:7", "diff:team:sess:abc"} {
		for _, m := range []string{http.MethodGet, http.MethodPost} {
			code, out := rig.do(m, "/api/artifacts/"+id+"/review-drafts", cmtAsOwner, map[string]any{"body": "x", "anchor": map[string]any{"whole": true}})
			assert.Equal(t, http.StatusBadRequest, code, "%s %s", m, id)
			assert.Equal(t, "drafts_not_supported", out["code"])
		}
	}
}
