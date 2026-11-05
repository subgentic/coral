package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// #13574: the Inbox's no-team source checks "nothing changed" against artifacts_all_rev (the list's own artifacts_rev is that number), so it must move when a no-team file is
// uploaded or tagged for review, and must stay put while nothing changes and across reads.
func TestAllArtifactsRevisionFollowsNoTeamFiles(t *testing.T) {
	srv, h, dir := teamArtifactServer(t)
	old := uploaderLookup
	uploaderLookup = func(context.Context, string) (string, string, string) { return "", "", "" }
	t.Cleanup(func() { uploaderLookup = old })

	got := getAllTeamArtifacts(t, srv, "?team=No+team", http.StatusOK)
	require.Equal(t, h.bs.ArtifactsRevision(""), got.Rev, "the list's artifacts_rev is the all-boards revision the page compares")
	idle := h.bs.ArtifactsRevision("")
	for i := 0; i < 3; i++ {
		getAllTeamArtifacts(t, srv, "?team=No+team", http.StatusOK)
	}
	require.Equal(t, idle, h.bs.ArtifactsRevision(""), "reads of an unchanged board do not move it")

	before := h.bs.ArtifactsRevision("")
	_, _, err := storeArtifact(dir, "solo-1", "screen.png", "image/png", []byte("png"))
	require.NoError(t, err)
	require.Greater(t, h.bs.ArtifactsRevision(""), before, "a no-team upload moves the all-boards revision")

	got = getAllTeamArtifacts(t, srv, "?team=No+team", http.StatusOK)
	require.Equal(t, h.bs.ArtifactsRevision(""), got.Rev)
	require.Len(t, got.Artifacts, 1)
	before = h.bs.ArtifactsRevision("")
	_, err = h.bs.AddArtifactTags(context.Background(), noTeamBoardID, got.Artifacts[0].ID, []string{"for review"})
	require.NoError(t, err)
	require.Greater(t, h.bs.ArtifactsRevision(""), before, "tagging a no-team file moves it")
}
