package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
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

// pinnedRig is the cross-team list over a kind rig's store, with a sessions database holding the stars.
type pinnedRig struct {
	k    *kindRig
	bh   *BoardHandler
	db   *sqlx.DB
	rout http.Handler
}

func newPinnedRig(t *testing.T) *pinnedRig {
	t.Helper()
	k := newKindRig(t)
	db, err := sqlx.Open("sqlite", filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`CREATE TABLE artifact_stars (hex TEXT PRIMARY KEY, starred_at TEXT NOT NULL)`)
	require.NoError(t, err)
	k.h.bs.SetSessionsDB(db)
	bh := NewBoardHandler(k.h.bs)
	bh.SetTaskArtifactWriter(k.coralDir, nil)
	r := chi.NewRouter()
	r.Get("/api/team-artifacts", bh.ListAllTeamArtifacts)
	r.Get("/api/board/{project}/artifacts", bh.ListTeamArtifacts)
	return &pinnedRig{k: k, bh: bh, db: db, rout: r}
}

func (p *pinnedRig) star(t *testing.T, digest, at string) {
	t.Helper()
	_, err := p.db.Exec(`INSERT INTO artifact_stars (hex, starred_at) VALUES (?, ?)`, digest, at)
	require.NoError(t, err)
}

func (p *pinnedRig) get(t *testing.T, path string, actor *Actor) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	if actor != nil {
		req = withActor(req, *actor)
	}
	rec := httptest.NewRecorder()
	p.rout.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func rowDigests(out map[string]any) []string {
	var ds []string
	for _, a := range out["artifacts"].([]any) {
		ds = append(ds, strings.TrimPrefix(a.(map[string]any)["digest"].(string), "sha256:"))
	}
	return ds
}

// #13910, pinned first: the starred series come first, once, at their newest version, whatever page they would have been on; the rest follow in the order asked for, and the cursor carries on through both.
func TestStarredFirstPutsTheStarredSeriesAtItsNewestVersionOnTheFirstPage(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	ctx := context.Background()
	_, doc := threeVersions(t, k) // doc.md, three versions, the OLDEST uploads
	var plain []string
	for _, name := range []string{"one.md", "two.md", "three.md"} { // three newer files in no series
		task, err := k.h.bs.CreateTask(ctx, "alpha", "OPERATOR "+name, "", "medium", "lead", "Backend")
		require.NoError(t, err)
		code, out := k.upTask("s1", task.ID, "plain file "+name, "&name="+name)
		require.Equal(t, 201, code, out)
		plain = append(plain, digestOfURI(out["uri"].(string)))
	}
	p.star(t, doc[0], "2026-11-06T10:00:00Z") // the star is on version ONE

	code, out := p.get(t, "/api/team-artifacts?tag=for+review&starred_first=true&limit=2", nil)
	require.Equal(t, 200, code, out)
	rows := out["artifacts"].([]any)
	first := rows[0].(map[string]any)
	assert.Equal(t, doc[2], strings.TrimPrefix(first["digest"].(string), "sha256:"), "the starred series is first, at its newest version, though its versions are the oldest uploads")
	assert.Equal(t, true, first["starred"])
	assert.Equal(t, "2026-11-06T10:00:00Z", first["starred_at"])
	assert.NotEmpty(t, first["series_id"])
	assert.EqualValues(t, 1, out["starred_total"])
	assert.Len(t, rows, 2, "the page is the limit: the pin and the newest of the rest")
	cursor, _ := out["next_cursor"].(string)
	require.NotEmpty(t, cursor)
	seen := rowDigests(out)
	code, out2 := p.get(t, "/api/team-artifacts?tag=for+review&starred_first=true&limit=2&cursor="+url.QueryEscape(cursor), nil)
	require.Equal(t, 200, code, out2)
	seen = append(seen, rowDigests(out2)...)
	assert.ElementsMatch(t, append([]string{doc[2]}, plain...), seen, "every row once across the pages, and no older version of the starred document")

	// not asked for: the plain order, and the document's row is starred (the star is on version one: it follows the series)
	code, out3 := p.get(t, "/api/team-artifacts?tag=for+review&limit=50", nil)
	require.Equal(t, 200, code)
	for _, a := range out3["artifacts"].([]any) {
		m := a.(map[string]any)
		if strings.TrimPrefix(m["digest"].(string), "sha256:") == doc[2] {
			assert.Equal(t, true, m["starred"], "version three says starred: the star was on version one")
		}
	}
	assert.Nil(t, out3["starred_total"])
}

func TestTheStarredViewIsOneRowPerSeriesAndStarredFirstIsOnlyOnTheCrossTeamList(t *testing.T) {
	p := newPinnedRig(t)
	_, doc := threeVersions(t, p.k)
	p.star(t, doc[1], "2026-11-06T10:00:00Z")
	code, out := p.get(t, "/api/team-artifacts?starred=true", nil)
	require.Equal(t, 200, code, out)
	rows := out["artifacts"].([]any)
	require.Len(t, rows, 1, "one row for the series")
	assert.Equal(t, doc[2], strings.TrimPrefix(rows[0].(map[string]any)["digest"].(string), "sha256:"), "its newest version")
	assert.EqualValues(t, 1, out["total"])
	code, _ = p.get(t, "/api/board/alpha/artifacts?starred_first=true", nil)
	assert.Equal(t, 400, code, "the per-board list refuses the parameter")
}

// MUST A (Security): the Operator's bookmarks are not an agent's, nor a Hub caller that is not the owner's, to read. starVisible is the one gate every list goes through; an agent's token reads no rows of these lists in
// this rig at all, so the gate is pinned directly, and what the Operator gets is pinned on the lists.
func TestTheStarFieldsAreTheOperatorsAloneAndOnlyOnTheCrossTeamList(t *testing.T) {
	op := httptest.NewRequest("GET", "/x", nil)
	assert.True(t, starVisible(op), "the dashboard or command line")
	agent := withActor(httptest.NewRequest("GET", "/x", nil), Actor{Kind: ActorToken, Name: "Backend", Session: "s1"})
	assert.False(t, starVisible(agent), "an agent's token")
	hub := httptest.NewRequest("GET", "/x", nil)
	hub.Header.Set(tunnel.ViaHeader, "x")
	assert.False(t, starVisible(hub), "a Hub caller with no owner stamp")

	p := newPinnedRig(t)
	_, doc := threeVersions(t, p.k)
	p.star(t, doc[0], "2026-11-06T10:00:00Z")
	_, cross := p.get(t, "/api/team-artifacts?starred=true", nil)
	require.NotEmpty(t, cross["artifacts"])
	row := cross["artifacts"].([]any)[0].(map[string]any)
	assert.Contains(t, row, "starred_at")
	assert.Contains(t, row, "series_id")
	// the per-board list is class a: its rows never carry the star-following fields, even for the Operator
	_, perBoard := p.get(t, "/api/board/alpha/artifacts", nil)
	require.NotEmpty(t, perBoard["artifacts"])
	for _, a := range perBoard["artifacts"].([]any) {
		assert.NotContains(t, a.(map[string]any), "starred_at")
		assert.NotContains(t, a.(map[string]any), "series_id")
	}
}
