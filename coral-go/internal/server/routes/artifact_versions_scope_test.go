package routes

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13999: GET /api/artifacts/{id}/versions for bytes that two teams hold in two series. The version bar passes its team (?board=) and gets that team's series, never the other's; without it the owner is told the
// answer is ambiguous (409 ambiguous_series, the teams named) instead of being handed whichever series came first. One team, or none in a series, answers as before.
func twoTeamsHoldTheSameBytes(t *testing.T) (rig *artifactRig, same string, aSecond, bSecond string) {
	t.Helper()
	rig, _ = ownerRig(t)
	same = rig.uploadText("a1", "plan.txt", "the same bytes")
	require.Equal(t, same, rig.uploadText("b1", "plan.txt", "the same bytes"), "one digest, two teams' records")
	code, out := rig.uploadVersion("a1", "plan.txt", "team a, second", "coral://artifacts/"+same)
	require.Equal(t, 201, code, out)
	aSecond = digestOfURI(out["uri"].(string))
	code, out = rig.uploadVersion("b1", "plan.txt", "team b, second and a third line", "coral://artifacts/"+same)
	require.Equal(t, 201, code, out)
	bSecond = digestOfURI(out["uri"].(string))
	require.NotEqual(t, aSecond, bSecond)
	return rig, same, aSecond, bSecond
}

func versionDigests(t *testing.T, body string) []string {
	t.Helper()
	var rows []struct {
		Digest string `json:"digest"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &rows), body)
	var out []string
	for _, r := range rows {
		out = append(out, r.Digest)
	}
	return out
}

func TestTheVersionsOfSharedBytesAreTheAskedTeamsOwnSeries(t *testing.T) {
	rig, same, aSecond, bSecond := twoTeamsHoldTheSameBytes(t)
	code, body := rig.getAs("", "/api/artifacts/"+same+"/versions?board=team-a")
	require.Equal(t, http.StatusOK, code, body)
	assert.Equal(t, []string{same, aSecond}, versionDigests(t, body), "team-a's series")
	code, body = rig.getAs("", "/api/artifacts/"+same+"/versions?board=team-b")
	require.Equal(t, http.StatusOK, code, body)
	assert.Equal(t, []string{same, bSecond}, versionDigests(t, body), "team-b's series")
	code, _ = rig.getAs("", "/api/artifacts/"+same+"/versions?board=team-o") // a team with no series of these bytes
	assert.Equal(t, http.StatusNotFound, code)
	code, _ = rig.getAs("", "/api/artifacts/"+same+"/versions?board=not%20a%20board")
	assert.Equal(t, http.StatusBadRequest, code)
}

func TestWithNoTeamTheOwnerIsToldItIsAmbiguousNotHandedAGuess(t *testing.T) {
	rig, same, aSecond, _ := twoTeamsHoldTheSameBytes(t)
	code, body := rig.getAs("", "/api/artifacts/"+same+"/versions")
	assert.Equal(t, http.StatusConflict, code, body)
	var out map[string]any
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	assert.Equal(t, "ambiguous_series", out["code"])
	assert.Equal(t, []any{"team-a", "team-b"}, out["boards"])
	// bytes only one team holds in a series answer as before, with no team named
	code, body = rig.getAs("", "/api/artifacts/"+aSecond+"/versions")
	require.Equal(t, http.StatusOK, code, body)
	assert.Len(t, versionDigests(t, body), 2)
}

func TestAnAgentKeepsItsOwnTeamsSeriesAndIsNeverToldAboutAnother(t *testing.T) {
	rig, same, aSecond, _ := twoTeamsHoldTheSameBytes(t)
	code, body := rig.getAs("a1", "/api/artifacts/"+same+"/versions")
	require.Equal(t, http.StatusOK, code, body)
	assert.Equal(t, []string{same, aSecond}, versionDigests(t, body))
}

// Security's small add: an agent's ?board= is ignored, as a guide's is, so the answer never tells it whether another team holds a series of the bytes (no 200-vs-404 hint, no other team's list).
func TestAnAgentsBoardKeyIsIgnored(t *testing.T) {
	rig, same, aSecond, _ := twoTeamsHoldTheSameBytes(t)
	for _, board := range []string{"team-a", "team-b", "team-o", "not%20a%20board"} {
		code, body := rig.getAs("a1", "/api/artifacts/"+same+"/versions?board="+board)
		require.Equal(t, http.StatusOK, code, "board=%s: %s", board, body)
		assert.Equal(t, []string{same, aSecond}, versionDigests(t, body), "board=%s: its own team's series, whatever it asked for", board)
	}
}
