package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
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

// Security's follow-ups on #13949: the delete's reply and its Activity row say the file was also held by other teams, the metadata of a digest tells the owner how many teams hold it, and a circle that cannot place an
// agent is logged once, not silently shown as a file with no series.
func TestDeletingSharedBytesSaysTheyWereInOtherTeamsToo(t *testing.T) {
	k, d, _, _ := twoTeamsSameBytes(t)
	pend := &activityPending{}
	req := httptest.NewRequest(http.MethodDelete, "/api/artifacts/"+d[0], nil)
	req = req.WithContext(context.WithValue(req.Context(), activityPendingKey{}, pend))
	req = withChiParam(req, "id", d[0])
	rec := httptest.NewRecorder()
	k.h.deleteArtifactCore(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"also_in_teams":1`)
	assert.True(t, pend.set, "the Activity row is asked for")
	assert.Equal(t, board.ActFileDelete, pend.action)
	assert.Contains(t, pend.note, "also held by 1 other team", "the row says the file was in another team too")

	// bytes only one team holds: no such words
	pend2 := &activityPending{}
	req2 := httptest.NewRequest(http.MethodDelete, "/api/artifacts/"+d[2], nil)
	req2 = req2.WithContext(context.WithValue(req2.Context(), activityPendingKey{}, pend2))
	req2 = withChiParam(req2, "id", d[2])
	rec2 := httptest.NewRecorder()
	k.h.deleteArtifactCore(rec2, req2)
	require.Equal(t, http.StatusOK, rec2.Code)
	assert.NotContains(t, rec2.Body.String(), "also_in_teams")
	assert.False(t, pend2.set)
}

func TestTeamsHoldingCountsEachTeamOnce(t *testing.T) {
	k, d, _, _ := twoTeamsSameBytes(t)
	assert.Equal(t, 2, teamsHolding(k.coralDir, d[0]), "alpha and beta")
	assert.Equal(t, 1, teamsHolding(k.coralDir, d[2]), "alpha only")
	assert.Equal(t, 0, teamsHolding(k.coralDir, strings.Repeat("e", 64)))
	assert.Equal(t, "", alsoInTeamsNote(1))
}

func TestACircleThatCannotPlaceAnAgentIsLoggedOnceAndShowsNoSeries(t *testing.T) {
	k, d, _, _ := twoTeamsSameBytes(t)
	useCircle(t, ArtifactCircle{
		SessionBoard: func(context.Context, string) (string, error) { return "", errors.New("the session store is down") },
		BoardOwner:   func(context.Context, string) (artifactPrincipal, error) { return operatorPrincipal, nil },
	})
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	circleWarn = sync.Once{}
	for i := 0; i < 3; i++ {
		_, _, ok := callerSeries(asSession("sa"), k.coralDir, d[0])
		assert.False(t, ok)
	}
	assert.Equal(t, 1, strings.Count(buf.String(), "could not be placed"), "one warning, however many reads: %s", buf.String())
}

// withChiParam sets one URL parameter of the route on a request.
func withChiParam(req *http.Request, key, val string) *http.Request {
	rc := chi.NewRouteContext()
	rc.URLParams.Add(key, val)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
}

// QA's request on #13949: each leak pinned at the HANDLER, over HTTP, with two teams holding the same bytes. alpha's series is d[0], d[1], d[2]; beta holds the SAME bytes as d[0] as the SECOND version of a series of
// its own (a beta v1 first), so the two teams give different answers about d[0] (version 1 of 3 on alpha, version 2 of 2 on beta). An agent of each team and a guide of each team's board ask the same route.
type scopeRig struct {
	*kindRig
	srv        *httptest.Server
	d          []string
	betaSeries string
}

func newScopeRig(t *testing.T) *scopeRig {
	t.Helper()
	k := newKindRig(t)
	_, d := threeVersions(t, k)
	dir := k.coralDir
	ctx := context.Background()
	rec, ok := readUploadRecord(dir, "s1", d[0])
	require.True(t, ok)
	betaDir := uploadsDir(dir, "s3")
	require.NoError(t, os.MkdirAll(betaDir, 0o700))
	betaSeries := strings.Repeat("b", 32)
	betaOne := strings.Repeat("c", 64)
	one := rec
	one.Board, one.SeriesID, one.Version, one.Previous, one.Digest = "beta", betaSeries, 1, "", "sha256:"+betaOne
	two := rec
	two.Board, two.SeriesID, two.Version, two.Previous = "beta", betaSeries, 2, betaOne
	for _, r := range []struct {
		digest string
		rec    agentUploadRecord
	}{{betaOne, one}, {d[0], two}} {
		b, _ := json.Marshal(r.rec)
		require.NoError(t, os.WriteFile(filepath.Join(betaDir, r.digest+".json"), b, 0o600))
	}
	require.NoError(t, writeSeriesIndex(dir, seriesIndex{ID: betaSeries, Board: "beta", CreatedAt: rec.CreatedAt, Versions: []seriesVersionRow{{Digest: betaOne, N: 1, Session: "s3", At: rec.CreatedAt}, {Digest: d[0], N: 2, Session: "s3", At: rec.CreatedAt}}}))
	// the agents: alpha's is the uploader session s1, beta's is s3; each is placed on its team as a launch does
	prev := artifactCircle
	SetArtifactCircle(NewArtifactCircle(k.ss, k.h.bs))
	t.Cleanup(func() { SetArtifactCircle(prev) })
	require.NoError(t, k.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "s1", AgentName: "a1", AgentType: "claude", WorkingDir: t.TempDir(), BoardName: ptr.NonEmpty("alpha")}))
	require.NoError(t, k.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "s3", AgentName: "a3", AgentType: "claude", WorkingDir: t.TempDir(), BoardName: ptr.NonEmpty("beta")}))
	k.h.commentOwner = func(*http.Request) (string, string, string) { return "local", "install-owner-id", "" }
	r := chi.NewRouter()
	ident := testIdentity(k.h.db)
	r.Use(func(next http.Handler) http.Handler {
		withIdent := ident(next)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.Header.Get(testDashboardHeader) != "" {
				next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie)))
				return
			}
			withIdent.ServeHTTP(w, req)
		})
	})
	k.h.RegisterAgentArtifacts(r)
	k.h.RegisterArtifactComments(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return &scopeRig{kindRig: k, srv: srv, d: d, betaSeries: betaSeries}
}

func (g *scopeRig) get(path string, hdr map[string]string) (int, map[string]any, []any) {
	g.t.Helper()
	req, err := http.NewRequest(http.MethodGet, g.srv.URL+path, nil)
	require.NoError(g.t, err)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(g.t, err)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var obj map[string]any
	var arr []any
	if json.Unmarshal(body, &obj) != nil {
		_ = json.Unmarshal(body, &arr)
	}
	return resp.StatusCode, obj, arr
}

func scopeGuide(board string) map[string]string {
	g := gaGuide(gaDana)
	g[tunnel.HubGuideBoardHeader] = board
	return g
}

func (g *scopeRig) alphaAgent() map[string]string { return map[string]string{testAgentHeader: "s1"} }
func (g *scopeRig) betaAgent() map[string]string  { return map[string]string{testAgentHeader: "s3"} }

func TestGETMetadataTellsEachTeamOnlyItsOwnSeriesOfTheSameBytes(t *testing.T) {
	g := newScopeRig(t)
	path := "/api/artifacts/" + g.d[0] + "/meta"
	alphaSeries, _, _ := digestSeriesOnBoard(g.coralDir, g.d[0], "alpha")
	for who, c := range map[string]struct {
		hdr     map[string]string
		series  string
		version int
		of      int
	}{
		"alpha's agent": {g.alphaAgent(), alphaSeries, 1, 3}, "beta's agent": {g.betaAgent(), g.betaSeries, 2, 2},
		"a guide of alpha": {scopeGuide("alpha"), alphaSeries, 1, 3}, "a guide of beta": {scopeGuide("beta"), g.betaSeries, 2, 2},
	} {
		code, out, _ := g.get(path, c.hdr)
		require.Equal(t, http.StatusOK, code, who+": "+fmt.Sprint(out))
		assert.Equal(t, c.series, out["series_id"], who)
		assert.EqualValues(t, c.version, out["version"], who)
		assert.EqualValues(t, c.of, out["versions"], who+": the count is its own team's")
	}
}

func TestGETVersionsOfADigestListsOnlyTheCallersOwnTeamsSeries(t *testing.T) {
	g := newScopeRig(t)
	path := "/api/artifacts/" + g.d[0] + "/versions"
	digests := func(arr []any) []string {
		var out []string
		for _, a := range arr {
			out = append(out, a.(map[string]any)["digest"].(string))
		}
		return out
	}
	code, _, arr := g.get(path, g.alphaAgent())
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{g.d[0], g.d[1], g.d[2]}, digests(arr), "alpha's agent: alpha's three versions")
	code, _, arr = g.get(path, g.betaAgent())
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{g.d[0]}, digests(arr), "beta's agent: beta's series (its first version has no stored copy here), and none of alpha's other versions")
	code, _, arr = g.get(path, scopeGuide("beta"))
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{g.d[0]}, digests(arr), "a guide of beta the same")
}

func TestCommentsWithSeriesOneNameTheCallersOwnTeamsVersionOnly(t *testing.T) {
	g := newScopeRig(t)
	ctx := context.Background()
	for _, board := range []string{"alpha", "beta"} {
		_, err := g.ss.CreateArtifactComment(ctx, store.ArtifactComment{ArtifactID: g.d[0], Board: board, AnchorJSON: `{"quote":"x"}`, Body: "on the document, " + board, AuthorIssuer: "local", AuthorSubject: "install-owner-id", AuthorKind: commentCallerOwner})
		require.NoError(t, err)
	}
	path := "/api/artifacts/" + g.d[0] + "/comments?series=1"
	versions := func(hdr map[string]string) []any {
		code, out, _ := g.get(path, hdr)
		require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
		var vs []any
		for _, c := range out["comments"].([]any) {
			vs = append(vs, c.(map[string]any)["version"])
		}
		return vs
	}
	for who, c := range map[string]struct {
		hdr  map[string]string
		want int
	}{"alpha's agent": {g.alphaAgent(), 1}, "beta's agent": {g.betaAgent(), 2}, "a guide of beta": {scopeGuide("beta"), 2}} {
		got := versions(c.hdr)
		require.NotEmpty(t, got, who)
		for _, v := range got {
			assert.EqualValues(t, c.want, v, who+": the version in its own team's series")
		}
	}
}
