package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21811: a file a linked team SENT this team (a received row on the team's own board) can be sent for review by the team's agents, which used to say "this team has no such file". A file the team was never sent is
// still not found for it, and the row of one team is not another team's.
func TestAFileAnotherTeamSentThisTeamCanBeSentForReview(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	bh.coralDir = rig.coralDir
	ctx := context.Background()
	upload := func(session, text string) string {
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id="+session, strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "report.md")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	}
	review := func(session, id string) (int, map[string]any) {
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts/"+id+"/review?session_id="+session, strings.NewReader(`{"question":"Is the report right?"}`))
		require.NoError(t, err)
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	sent := upload("b1", "the linked team's report")
	notSent := upload("b1", "a file of theirs nobody sent")

	code, _ := review("a1", sent)
	assert.Equal(t, http.StatusNotFound, code, "not sent to team-a yet")

	require.NoError(t, bh.writeCrossTeamRecord("received", crossTeamArtifactRecord{ID: sent, Name: "report.md", Board: "team-a", OtherBoard: "team-b", Server: "local", By: "Orchestrator", At: "2026-11-27T00:00:00Z"}))
	code, out := review("a1", sent)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["for_review"])
	tags, err := rig.h.bs.ArtifactTags(ctx, "team-a")
	require.NoError(t, err)
	assert.Contains(t, tags[sent], "for review")
	rec, ok := readUploadRecord(rig.coralDir, "a1", sent)
	require.True(t, ok, "the team's own record of the file is made")
	assert.Equal(t, "team-a", rec.Board)
	assert.Equal(t, "team-b", rec.ReceivedFrom)

	code, _ = review("a1", notSent)
	assert.Equal(t, http.StatusNotFound, code, "a file the team was never sent")
	code, _ = review("b1", sent) // the sender's own file stays its own
	assert.Equal(t, http.StatusOK, code)
}
