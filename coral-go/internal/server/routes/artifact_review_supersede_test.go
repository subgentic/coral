package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #136588 (Mobile Beta Tester, live): after Request changes on v1, an upload of v2 in the same series with --tag "for review" closes v1's review: v1 leaves Needs you as superseded and keeps no
// "changes requested" tag; v2 is the one pending.
func TestANewVersionForReviewSupersedesTheOlderOne(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	ctx := context.Background()
	up := func(session, text, ref string) string {
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id="+session+"&tag=for+review&question=Approve+the+spec%3F", strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "spec.md")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		if ref != "" {
			req.Header.Set(seriesHeader, ref)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Contains(t, []int{http.StatusOK, http.StatusCreated}, resp.StatusCode, text)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	}
	v1 := up("a1", "spec v1", "")
	_, _, err := rig.h.bs.DecideArtifactReview(ctx, "team-a", v1, board.ReviewChangesRequested, time.Now())
	require.NoError(t, err)
	v2 := up("a1", "spec v2", "coral://artifacts/"+v1)

	tags, err := rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.Equal(t, []string{"superseded"}, tags[v1], "v1 is no longer something to review, and keeps no changes requested tag")
	assert.Contains(t, tags[v2], "for review", "v2 is the pending one")
}

// #11985 (the operator): after Request changes the file leaves Needs you, so the agent's next version must come back: an upload of version 2 of a file whose changes were requested is tagged for review even
// when the agent forgot --tag, closes version 1's review, and is the one thing /api/needs-you lists; without it the file would vanish from Needs you without a trace.
func TestTheNextVersionOfAFileWithChangesRequestedComesBackForReview(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	bh.coralDir = rig.coralDir
	ctx := context.Background()
	up := func(session, text, ref string, tagged bool) string {
		url := rig.srv.URL + "/api/agent/artifacts?session_id=" + session
		if tagged {
			url += "&tag=for+review&question=Approve+the+spec%3F"
		}
		req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "spec.md")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		if ref != "" {
			req.Header.Set(seriesHeader, ref)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Contains(t, []int{http.StatusOK, http.StatusCreated}, resp.StatusCode, text)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	}
	v1 := up("a1", "spec v1", "", true)
	_, _, err := rig.h.bs.DecideArtifactReview(ctx, "team-a", v1, board.ReviewChangesRequested, time.Now())
	require.NoError(t, err)
	// the agent forgets --tag
	v2 := up("a1", "spec v2", "coral://artifacts/"+v1, false)
	tags, err := rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.Contains(t, tags[v2], "for review", "the next version of a file with changes requested is for review even without --tag")
	assert.Equal(t, []string{"superseded"}, tags[v1], "and version 1's review is closed")
	// a first upload with no tag stays untagged: only a file whose changes were requested is brought back
	plain := up("a1", "something else", "", false)
	tags, err = rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.NotContains(t, tags[plain], "for review", "an ordinary upload is not tagged for review")
}
