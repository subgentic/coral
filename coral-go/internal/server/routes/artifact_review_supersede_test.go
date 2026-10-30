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
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id="+session+"&tag=for+review", strings.NewReader(text))
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
