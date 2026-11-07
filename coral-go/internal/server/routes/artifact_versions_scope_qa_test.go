package routes

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// QA's probes on #13999 (be-13999 196f572c3). The first one is RED at 196f572c3: an agent that names another team in ?board= is handed that team's series (the guide is excluded from the board branch, an agent is not).

// An agent that names another team in ?board= must still read only ITS OWN team's series: the board parameter is for the version bar of the Operator, and an agent is placed by its launch (callerSeries), not by a
// query value. (#13949 closed this for every other series read.)
func TestAnAgentNamingAnotherTeamInBoardStillGetsItsOwnTeamsSeriesOnly(t *testing.T) {
	rig, same, aSecond, bSecond := twoTeamsHoldTheSameBytes(t)
	code, body := rig.getAs("a1", "/api/artifacts/"+same+"/versions?board=team-b")
	if code == http.StatusOK {
		got := versionDigests(t, body)
		assert.NotContains(t, got, bSecond, "team-a's agent was handed team-b's series by asking for it: %v", got)
		assert.Equal(t, []string{same, aSecond}, got, "its own team's series, whatever board it names")
	} else {
		assert.Contains(t, []int{http.StatusNotFound, http.StatusForbidden}, code, "a refusal is also fine: %d %s", code, body)
	}
	// and team-b's agent naming team-a
	code, body = rig.getAs("b1", "/api/artifacts/"+same+"/versions?board=team-a")
	if code == http.StatusOK {
		got := versionDigests(t, body)
		assert.NotContains(t, got, aSecond, "team-b's agent was handed team-a's series: %v", got)
	}
}

// An agent on a team that holds the bytes in no series, naming a team that does, learns nothing of it.
func TestAnAgentOfAThirdTeamNamingATeamLearnsNothing(t *testing.T) {
	rig, same, aSecond, bSecond := twoTeamsHoldTheSameBytes(t)
	code, body := rig.getAs("o1", "/api/artifacts/"+same+"/versions?board=team-a")
	if code == http.StatusOK {
		got := versionDigests(t, body)
		assert.NotContains(t, got, aSecond)
		assert.NotContains(t, got, bSecond)
	}
	assert.NotEqual(t, http.StatusConflict, code, "the 409 names the teams that hold the bytes: not an agent's to be told")
}

// The ambiguity answer is the owner's alone: an agent whose team is one of the two is never given a 409 naming the other.
func TestTheAmbiguousAnswerNeverReachesAnAgent(t *testing.T) {
	rig, same, _, _ := twoTeamsHoldTheSameBytes(t)
	for _, s := range []string{"a1", "b1", "o1", "n1"} {
		code, body := rig.getAs(s, "/api/artifacts/"+same+"/versions")
		assert.NotEqual(t, http.StatusConflict, code, s+": "+body)
		assert.NotContains(t, body, "team-b", s+" must not read another team's name")
	}
}

// ~no-team is a valid board key and a board name that is not one is a 400; an empty board is the no-board answer.
func TestTheBoardParameterIsValidatedAndEmptyMeansNone(t *testing.T) {
	rig, same, _, _ := twoTeamsHoldTheSameBytes(t)
	for _, bad := range []string{"%2e%2e", "a%2Fb", "TEAM-A%20", "x%00y"} {
		code, _ := rig.getAs("", "/api/artifacts/"+same+"/versions?board="+bad)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	code, _ := rig.getAs("", "/api/artifacts/"+same+"/versions?board=")
	assert.Equal(t, http.StatusConflict, code, "an empty board is no board: still ambiguous")
	code, _ = rig.getAs("", "/api/artifacts/"+same+"/versions?board=team-a&board=team-b")
	assert.Contains(t, []int{http.StatusOK, http.StatusBadRequest}, code, "two boards: the first is used or the request is refused, never both")
	_ = require.New(t)
}
