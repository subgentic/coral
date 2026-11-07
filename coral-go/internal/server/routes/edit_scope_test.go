package routes

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13942 (Frontend Dev's proof on #13940, source coral://artifacts/d3c64af17302470d99c14b496ae0a5f694f9b61116a8e502ed1559a14e14c0a8): two teams that uploaded the same bytes on their own are two files. The series
// lookup of the edit capability, of a save, of Send to agent and of the chain's join was the digest's first series on ANY team; it is the requested team's own now.
func TestEditCapabilityForSameBytesOnAnotherBoard13940(t *testing.T) {
	e := newEditEnv(t, "person")
	original := e.seed(t, sessAlice, "alpha.md", "text/markdown", "", "# Shared original\n")
	code, _ := e.save(t, "alpha", original, original, "# Alpha edited\n", nil)
	require.Equal(t, http.StatusCreated, code)
	same := e.seed(t, sessBob, "beta.md", "text/markdown", "", "# Shared original\n")
	require.Equal(t, original, same)
	resp, err := http.Get(e.srv.URL + "/api/board/beta/artifacts/" + same + "/edit")
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.Equal(t, http.StatusOK, resp.StatusCode, "beta uploaded this digest independently: %v", out)
	require.Equal(t, true, out["can_edit"])
	require.Equal(t, "beta.md", out["name"])
}

// A save on the second team lands in the second team's own series; the first team's series is untouched, and the first team still edits its own.
func TestASaveOnTheSecondTeamNeverLandsInTheFirstTeamsSeries(t *testing.T) {
	e := newEditEnv(t, "person")
	original := e.seed(t, sessAlice, "alpha.md", "text/markdown", "", "# Shared original\n")
	code, out := e.save(t, "alpha", original, original, "# Alpha edited\n", nil)
	require.Equal(t, http.StatusCreated, code, out)
	alphaSeries, _ := out["series_id"].(string)
	require.NotEmpty(t, alphaSeries)
	before := len(seriesMembers(e.coralDir, alphaSeries))
	e.seed(t, sessBob, "beta.md", "text/markdown", "", "# Shared original\n")
	code, out = e.save(t, "beta", original, original, "# Beta edited\n", nil)
	require.Equal(t, http.StatusCreated, code, out)
	betaSeries, _ := out["series_id"].(string)
	require.NotEmpty(t, betaSeries)
	assert.NotEqual(t, alphaSeries, betaSeries, "beta's save is a series of its own")
	assert.Equal(t, before, len(seriesMembers(e.coralDir, alphaSeries)), "alpha's series did not gain beta's text")
	for _, m := range seriesMembers(e.coralDir, betaSeries) {
		assert.Equal(t, "beta", m.Board)
	}
	for _, m := range seriesMembers(e.coralDir, alphaSeries) {
		assert.Equal(t, "alpha", m.Board)
	}
}

// planNewVersion, the agent's path (and #13908's chain join): bytes the caller's team has, that another team has in a series, start the caller's own series.
func TestAnAgentNewVersionOfBytesAnotherTeamHasInASeriesIsItsOwnSeries(t *testing.T) {
	e := newEditEnv(t, "person")
	original := e.seed(t, sessAlice, "alpha.md", "text/markdown", "", "# Shared original\n")
	code, _ := e.save(t, "alpha", original, original, "# Alpha edited\n", nil)
	require.Equal(t, http.StatusCreated, code)
	e.seed(t, sessBob, "beta.md", "text/markdown", "", "# Shared original\n")
	plan, err := planNewVersion(e.coralDir, "coral://artifacts/"+original, "beta", "feedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed")
	require.NoError(t, err)
	defer plan.unlock()
	assert.True(t, plan.create, "beta's own new series, not alpha's")
	assert.Equal(t, "beta", plan.board)
	for _, m := range plan.rows {
		assert.Equal(t, "beta", m.Board)
	}
}

// Send to agent (#13802): the same bytes another team uploaded on its own are not an edit of the Operator on that team, and they are not "another team's series" either (a 404 that told a series exists).
func TestSendToAgentForBytesAnotherTeamHoldsInASeriesIsNotThatTeamsSeries(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.edited() // team-a: v1 an agent's, v2 the Operator's editor save
	// team-b uploaded the same bytes as v2 on its own: a record on team-b with no series
	up := filepath.Join(rig.h.cfg.CoralDir(), "artifacts", "uploads", "s2")
	require.NoError(t, os.MkdirAll(up, 0o755))
	rec := agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "plan.md", MediaType: "text/markdown", Size: 21, Digest: "sha256:" + editV2}, CreatedAt: time.Now().UTC().Format(time.RFC3339), Board: "team-b"}
	b, _ := json.Marshal(rec)
	require.NoError(t, os.WriteFile(filepath.Join(up, editV2+".json"), b, 0o600))
	code, out := rig.do("POST", "/api/board/team-b/artifacts/"+editV2+"/edit/send", editAsPage, map[string]any{"agents": []string{"Dev"}})
	assert.Equal(t, http.StatusConflict, code, "on team-b the bytes are no edit of the Operator: %v", out)
	assert.Equal(t, "not_an_edit", out["code"])
	code, _ = rig.do("GET", "/api/board/team-b/artifacts/"+editV2+"/edit/send", editAsPage, nil)
	assert.Equal(t, http.StatusConflict, code, "and the read hides the action")
	assert.Empty(t, rig.operatorMessages())
}
