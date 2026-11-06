package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13910: the star follows the series. One document, three versions: a star on any version stars them all, the newest is the one a pinned list shows, and an unstar of any clears the series.

func digestOfURI(uri string) string { return strings.TrimPrefix(uri, "coral://artifacts/") }

// threeVersions makes one task's file for review, uploaded three times: a series of three versions (oldest first).
func threeVersions(t *testing.T, k *kindRig) (task int64, digests []string) {
	t.Helper()
	root, err := k.h.bs.CreateTask(context.Background(), "alpha", "OPERATOR the document", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	for _, body := range []string{"the document, version one", "the document, version two", "the document, version three"} {
		code, out := k.upTask("s1", root.ID, body, "&name=doc.md")
		require.Equal(t, 201, code, out)
		digests = append(digests, digestOfURI(out["uri"].(string)))
	}
	return root.ID, digests
}

func TestAStarOnAnyVersionStarsTheSeriesAndTheNewestIsTheLatest(t *testing.T) {
	k := newKindRig(t)
	_, d := threeVersions(t, k)
	dir := k.coralDir
	got := starFollow(dir, map[string]string{d[0]: "2026-11-06T10:00:00Z"})
	require.Len(t, got, 3, "the star on v1 is on every version of the series")
	assert.Equal(t, 3, len(got))
	sid := got[d[2]].Series
	require.NotEmpty(t, sid)
	for _, x := range d {
		assert.Equal(t, sid, got[x].Series)
		assert.Equal(t, "2026-11-06T10:00:00Z", got[x].At)
	}
	assert.True(t, got[d[2]].Latest, "the newest version is the one a pinned list shows")
	assert.False(t, got[d[0]].Latest)
	assert.False(t, got[d[1]].Latest)
	// two versions starred at different times: the series says the newer star
	got = starFollow(dir, map[string]string{d[0]: "2026-11-06T10:00:00Z", d[1]: "2026-11-06T12:00:00Z"})
	assert.Equal(t, "2026-11-06T12:00:00Z", got[d[2]].At)
	// a file in no series is starred as itself
	got = starFollow(dir, map[string]string{strings.Repeat("a", 64): "2026-11-06T09:00:00Z"})
	require.Len(t, got, 1)
	assert.True(t, got[strings.Repeat("a", 64)].Latest)
	assert.Empty(t, got[strings.Repeat("a", 64)].Series)
}

func TestAnUnstarOfAnyVersionClearsTheWholeSeriesAndNothingElse(t *testing.T) {
	k := newKindRig(t)
	_, d := threeVersions(t, k)
	other := strings.Repeat("b", 64) // some other starred file
	ctx := context.Background()
	call := func(method, id string) (int, map[string]any) {
		req := httptest.NewRequest(method, "/api/artifacts/"+id+"/star", nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rc := chi.NewRouteContext()
		rc.URLParams.Add("id", id)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
		rec := httptest.NewRecorder()
		k.h.starArtifactRoute(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	for _, id := range []string{d[0], d[2]} { // two versions starred
		_, err := k.h.db.ExecContext(ctx, "INSERT INTO artifact_stars (hex, starred_at) VALUES (?, ?)", id, "2026-11-06T10:00:00Z")
		require.NoError(t, err)
	}
	_, err := k.h.db.ExecContext(ctx, "INSERT INTO artifact_stars (hex, starred_at) VALUES (?, ?)", other, "2026-11-06T10:00:00Z")
	require.NoError(t, err)
	code, out := call(http.MethodDelete, d[1]) // the unstar comes from the MIDDLE version
	require.Equal(t, 200, code, out)
	assert.Equal(t, false, out["starred"])
	assert.NotEmpty(t, out["series_id"], "the reply says which series")
	var n int
	require.NoError(t, k.h.db.Reader().GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_stars WHERE hex IN (?, ?, ?)", d[0], d[1], d[2]))
	assert.Zero(t, n, "every version's star is gone")
	require.NoError(t, k.h.db.Reader().GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_stars WHERE hex = ?", other))
	assert.Equal(t, 1, n, "another file's star is untouched")
}

func TestTheOperatorsBookmarksAreNotShownToAnAgentTokenOrAHubCallerThatIsNotTheOwner(t *testing.T) {
	op := httptest.NewRequest("GET", "/x", nil)
	assert.True(t, starVisible(op), "the dashboard or command line sees its own stars")
	agent := withActor(httptest.NewRequest("GET", "/x", nil), Actor{Kind: ActorToken, Name: "Dev", Session: "s1"})
	assert.False(t, starVisible(agent), "an agent's token never sees them")
}
