package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #13949: the remaining digest-only series lookups, each with two teams that hold the same bytes (twoTeamsSameBytes: alpha's series d[0], d[1], d[2]; beta's series d[0], betaTwo).

func asSession(sid string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	return req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sid, SessionName: "claude-" + sid}))
}

// GET metadata, the versions list and ?series=1 on the comments (all three through callerSeries): an agent sees its own team's series of the bytes, never the other team's id or counts; the owner keeps the digest's first.
func TestAnAgentSeesOnlyItsOwnTeamsSeriesOfBytesTwoTeamsHold(t *testing.T) {
	k, d, betaSeries, _ := twoTeamsSameBytes(t)
	useCircle(t, ArtifactCircle{
		SessionBoard: func(_ context.Context, sid string) (string, error) {
			return map[string]string{"sa": "alpha", "sb": "beta", "sn": ""}[sid], nil
		},
		BoardOwner: func(context.Context, string) (artifactPrincipal, error) { return operatorPrincipal, nil },
	})
	alphaSeries, _, ok := digestSeriesOnBoard(k.coralDir, d[0], "alpha")
	require.True(t, ok)
	require.NotEqual(t, alphaSeries, betaSeries)

	sid, _, ok := callerSeries(asSession("sa"), k.coralDir, d[0])
	require.True(t, ok)
	assert.Equal(t, alphaSeries, sid, "alpha's agent sees alpha's series")
	sid, _, ok = callerSeries(asSession("sb"), k.coralDir, d[0])
	require.True(t, ok)
	assert.Equal(t, betaSeries, sid, "beta's agent sees beta's: the same bytes, its own file")
	_, _, ok = callerSeries(asSession("sb"), k.coralDir, d[2])
	assert.False(t, ok, "bytes only alpha holds in a series say nothing to beta")
	_, _, ok = callerSeries(asSession("sn"), k.coralDir, d[0])
	assert.False(t, ok, "an agent on no team sees no team's series")
	_, _, ok = callerSeries(asSession(""), k.coralDir, d[0])
	assert.False(t, ok)
	_, _, ok = callerSeries(httptest.NewRequest(http.MethodGet, "/x", nil), k.coralDir, d[2])
	assert.True(t, ok, "the owner reads every team")
}

// The version line a comment sent to a team's agent carries is that team's own: version 1 of beta's two, not of alpha's three.
func TestTheVersionLineOfASentCommentIsTheReceivingTeamsOwn(t *testing.T) {
	k, d, _, _ := twoTeamsSameBytes(t)
	alpha := k.h.sendVersionLine(d[0], "alpha")
	beta := k.h.sendVersionLine(d[0], "beta")
	assert.Contains(t, alpha, "v1 of 3", "alpha's series has three versions: %s", alpha)
	assert.NotEqual(t, alpha, beta, "the two teams' lines differ")
	assert.Contains(t, beta, "v1 of 2", "beta's has two: %s", beta)
	assert.Equal(t, "coral://artifacts/"+d[2], k.h.sendVersionLine(d[2], "beta"))
}

// Delete: the object is one file of shared bytes the Operator deletes with every row that lists it, and the digest is forgotten in EVERY team's series that has it; any other version of either series is untouched.
func TestDeletingSharedBytesForgetsThemInEveryTeamsSeriesAndKeepsTheOtherVersions(t *testing.T) {
	k, d, betaSeries, betaTwo := twoTeamsSameBytes(t)
	alphaSeries, _, _ := digestSeriesOnBoard(k.coralDir, d[0], "alpha")
	_, _, found, err := deleteArtifactFiles(k.coralDir, d[0])
	require.NoError(t, err)
	require.True(t, found)
	digests := func(sid string) []string {
		idx, ok := readSeriesIndex(k.coralDir, sid)
		require.True(t, ok)
		var out []string
		for _, v := range idx.Versions {
			out = append(out, v.Digest)
		}
		return out
	}
	assert.Equal(t, []string{d[1], d[2]}, digests(alphaSeries), "alpha's series forgot the deleted version and kept the others")
	assert.Equal(t, []string{betaTwo}, digests(betaSeries), "beta's series forgot it too: the second team's index is no longer pointing at bytes that are gone")
	for _, keep := range []string{d[1], d[2]} {
		_, statErr := os.Stat(filepath.Join(k.coralDir, "artifacts", "objects", keep))
		assert.NoError(t, statErr, "alpha's other versions are still there")
	}
	_, statErr := os.Stat(filepath.Join(k.coralDir, "artifacts", "objects", d[0]))
	assert.True(t, os.IsNotExist(statErr))
}

// Prune: a digest that is a version of ANY team's series is protected (the check asks every record, not the first), and bytes in no series are not.
func TestAPruneNeverTakesAVersionOfAnyTeamsSeries(t *testing.T) {
	k, d, _, betaTwo := twoTeamsSameBytes(t)
	for name, id := range map[string]string{"shared bytes, in both teams' series": d[0], "alpha only": d[2], "beta only": betaTwo} {
		protected, err := k.h.isProtected(context.Background(), id)
		require.NoError(t, err)
		assert.True(t, protected, name)
	}
	protected, err := k.h.isProtected(context.Background(), strings.Repeat("e", 64))
	require.NoError(t, err)
	assert.False(t, protected, "bytes in no series")
}
