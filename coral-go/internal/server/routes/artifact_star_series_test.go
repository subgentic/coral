package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
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
	rout http.Handler
}

func newPinnedRig(t *testing.T) *pinnedRig {
	t.Helper()
	k := newKindRig(t)
	db := k.h.db.Reader() // the board store reads the same sessions database the handler writes, as in the server (server.go: SetSessionsDB(db.Reader()))
	k.h.bs.SetSessionsDB(db)
	bh := NewBoardHandler(k.h.bs)
	bh.SetTaskArtifactWriter(k.coralDir, nil)
	r := chi.NewRouter()
	r.Get("/api/team-artifacts", bh.ListAllTeamArtifacts)
	r.Get("/api/board/{project}/artifacts", bh.ListTeamArtifacts)
	return &pinnedRig{k: k, bh: bh, rout: r}
}

func (p *pinnedRig) star(t *testing.T, digest, at string) {
	t.Helper()
	_, err := p.k.h.db.ExecContext(context.Background(), `INSERT INTO artifact_stars (hex, starred_at) VALUES (?, ?)`, digest, at)
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
	assert.Equal(t, []any{doc[0], doc[1]}, first["earlier_digests"], "the older versions, oldest first, so a decision on this row can settle them")
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

// #13910 (the row's "New version v3"): the newest version the Operator has opened, per person, team and series; only ever raised, never above the series' newest, from the server's own records.
func TestOpenedRecordsTheNewestVersionTheOperatorOpenedAndOnlyRaisesIt(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	_, d := threeVersions(t, k)
	post := func(id string, actor *Actor) (int, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, "/api/artifacts/"+id+"/opened", nil)
		if actor != nil { // an agent's token: no dashboard cookie
			req = withActor(req, *actor)
		} else {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		rc := chi.NewRouteContext()
		rc.URLParams.Add("id", id)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
		rec := httptest.NewRecorder()
		k.h.openedArtifactRoute(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, out := post(d[0], nil)
	require.Equal(t, 200, code, out)
	assert.EqualValues(t, 1, out["opened_version"])
	assert.NotEmpty(t, out["series_id"])
	code, out = post(d[2], nil)
	require.Equal(t, 200, code, out)
	assert.EqualValues(t, 3, out["opened_version"])
	code, out = post(d[1], nil) // an older version opened later never lowers it
	require.Equal(t, 200, code, out)
	assert.EqualValues(t, 3, out["opened_version"], "only ever raised")

	// the cross-team row says it: series id and the opened version, for the Operator
	_, list := p.get(t, "/api/team-artifacts?tag=for+review", nil)
	require.NotEmpty(t, list["artifacts"], list)
	row := list["artifacts"].([]any)[0].(map[string]any)
	assert.EqualValues(t, 3, row["versions"])
	assert.EqualValues(t, 3, row["opened_version"])
	assert.Equal(t, out["series_id"], row["series_id"])
	// not on the per-board list
	_, perBoard := p.get(t, "/api/board/alpha/artifacts?tag=for+review", nil)
	assert.NotContains(t, perBoard["artifacts"].([]any)[0].(map[string]any), "opened_version")

	// an agent's token is refused, a file in no series and an unknown digest are 404, a bad id is 400
	code, _ = post(d[0], &Actor{Kind: ActorToken, Name: "Backend", Session: "s1"})
	assert.Equal(t, http.StatusForbidden, code, "an agent never records what the Operator opened")
	code, _ = post(strings.Repeat("c", 64), nil)
	assert.Equal(t, http.StatusNotFound, code, "no such artifact says the same as one in no series")
	code, _ = post("nope", nil)
	assert.Equal(t, http.StatusBadRequest, code)
	var n int
	require.NoError(t, k.h.db.Reader().GetContext(context.Background(), &n, "SELECT COUNT(*) FROM artifact_series_opened"))
	assert.Equal(t, 1, n, "one row per person, team and series")
}

func TestThePersonKeyIsTheOwnersOnAPersonalComputerAndTheHubUserOnATeams(t *testing.T) {
	assert.Equal(t, "owner", personKeyOf(callerIdentity{owner: true}), "the local dashboard and the Hub owner are one person")
	assert.Equal(t, "owner", personKeyOf(callerIdentity{owner: true, hubUserID: "u1"}), "a personal computer: the Hub user label is not a different person")
	assert.Equal(t, "hub:org-1:u1", personKeyOf(callerIdentity{owner: true, team: true, org: "org-1", hubUserID: "u1"}))
	assert.NotEqual(t, personKeyOf(callerIdentity{owner: true, team: true, org: "org-1", hubUserID: "u2"}), personKeyOf(callerIdentity{owner: true, team: true, org: "org-1", hubUserID: "u1"}), "two people of one organisation each have their own")
	local := httptest.NewRequest("GET", "/x", nil)
	assert.Equal(t, "owner", openedPersonKey(local))
}

// #13910 (Frontend Dev Teams UI): the cross-team list's team filter takes real board ids, a renamed team by its id, and the no-team files by their key as well as by their label.
func TestTheTeamFilterTakesBoardIdsIncludingTheNoTeamKey(t *testing.T) {
	p := newPinnedRig(t)
	_, doc := threeVersions(t, p.k)
	_, all := p.get(t, "/api/team-artifacts?tag=for+review", nil)
	require.NotEmpty(t, all["artifacts"])
	_, byID := p.get(t, "/api/team-artifacts?tag=for+review&team=alpha", nil)
	require.NotEmpty(t, byID["artifacts"], "a team by its board id")
	assert.Equal(t, doc[2], strings.TrimPrefix(byID["artifacts"].([]any)[0].(map[string]any)["digest"].(string), "sha256:"))
	_, other := p.get(t, "/api/team-artifacts?tag=for+review&team=beta", nil)
	assert.Empty(t, other["artifacts"], "another team's id finds none of alpha's")
	for _, q := range []string{"team=~no-team", "team=No+team", "team=Not+on+a+team"} {
		code, out := p.get(t, "/api/team-artifacts?"+q, nil)
		assert.Equal(t, 200, code, q)
		for _, a := range out["artifacts"].([]any) {
			assert.NotEqual(t, "alpha", a.(map[string]any)["board_id"], "the no-team key asks for the no-team files only: "+q)
		}
	}
}

// #13910, per-person stars (the Operator approved a mock with them): the owner key's stars are the original table's and an upgrade loses none; another person's are their own and never shown to the owner key, nor the
// owner key's to them. The person is the verified one the opened version uses.
func TestStarsArePerPersonAndTheOwnerKeysAreTheOriginalTable(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	_, d := threeVersions(t, k)
	ctx := context.Background()
	other := "hub:org-1:u1"
	_, err := k.h.star(ctx, ownerPersonKey, d[0])
	require.NoError(t, err)
	_, err = k.h.star(ctx, other, d[2])
	require.NoError(t, err)
	var n int
	require.NoError(t, k.h.db.Reader().GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_stars"))
	assert.Equal(t, 1, n, "the owner key's star is in the original table")
	require.NoError(t, k.h.db.Reader().GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_person_stars"))
	assert.Equal(t, 1, n)

	own, err := k.h.bs.StarredArtifactTimes(ctx, ownerPersonKey)
	require.NoError(t, err)
	assert.Equal(t, 1, len(own))
	assert.Contains(t, own, d[0])
	mine, err := k.h.bs.StarredArtifactTimes(ctx, other)
	require.NoError(t, err)
	assert.Equal(t, 1, len(mine))
	assert.Contains(t, mine, d[2], "another person sees only their own")
	nobody, err := k.h.bs.StarredArtifactTimes(ctx, "hub:org-1:u2")
	require.NoError(t, err)
	assert.Empty(t, nobody, "and a third person sees none of either")

	// the lists read the caller's: the local dashboard is the owner key
	ids, err := k.h.starredArtifactIDs(ctx, ownerPersonKey)
	require.NoError(t, err)
	assert.Len(t, ids, 3, "the owner key's star on version one follows the series")
	ids, err = k.h.starredArtifactIDs(ctx, "hub:org-1:u2")
	require.NoError(t, err)
	assert.Empty(t, ids)

	// an unstar by one person clears only theirs
	_, err = k.h.unstar(ctx, other, d[2])
	require.NoError(t, err)
	own, _ = k.h.bs.StarredArtifactTimes(ctx, ownerPersonKey)
	assert.Contains(t, own, d[0], "the owner key's star is untouched by another person's unstar")
}

// #13910: the person key from a REAL stamped Hub request (not a hand-made identity): on an organisation's computer each Hub user of the organisation has their own, on a personal computer the Hub owner is the local owner's
// key, and a stamp of another organisation never gets a key at all.
func TestThePersonKeyFromARealStampedHubRequest(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, "", nil)
	withRecord(t, "team", teamOrgA, nil)
	keyOf := func(hdr http.Header) string {
		req := httptest.NewRequest(http.MethodPost, "/api/artifacts/"+strings.Repeat("a", 64)+"/opened", nil)
		req.Header = hdr
		return openedPersonKey(req)
	}
	a := keyOf(teamStamp(teamOrgA, "admin", teamUIDA, teamUser))
	b := keyOf(teamStamp(teamOrgA, "admin", teamUIDB, teamUser))
	assert.Equal(t, "hub:"+teamOrgA+":"+teamUIDA, a)
	assert.Equal(t, "hub:"+teamOrgA+":"+teamUIDB, b)
	assert.NotEqual(t, a, b, "two people of one organisation")
	assert.Equal(t, "owner", keyOf(teamStamp(teamOrgB, "owner", teamUIDA, teamUser)), "a stamp of another organisation is no team person: the constant key, and the owner routes refuse it anyway")

	resetOwnerState(t)
	withRecord(t, "personal", "", nil)
	withLabel(t, ownerLabel, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/artifacts/"+strings.Repeat("a", 64)+"/opened", nil)
	for k, v := range ownerHeaders(ownerLabel) {
		req.Header.Set(k, v)
	}
	assert.Equal(t, "owner", openedPersonKey(req), "the Hub owner of a personal computer is the local owner's key")
}

// QA's three pins on #13910, each against a mutant no test failed.

// 1. The opened version is never above the series' newest: on the write (the digest's own record says version 3, the series index has two) and on the read (a row left over from a version since gone).
func TestTheOpenedVersionIsNeverAboveTheSeriesNewest(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	_, d := threeVersions(t, k)
	dir := k.coralDir
	sid, _, ok := digestSeries(dir, d[0])
	require.True(t, ok)
	idx, found := readSeriesIndex(dir, sid)
	require.True(t, found)
	require.Len(t, idx.Versions, 3)
	idx.Versions = idx.Versions[:2] // the series says two versions while the third's own record says it is version 3
	require.NoError(t, writeSeriesIndex(dir, idx))
	req := httptest.NewRequest(http.MethodPost, "/api/artifacts/"+d[2]+"/opened", nil)
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", d[2])
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	rec := httptest.NewRecorder()
	k.h.openedArtifactRoute(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.EqualValues(t, 2, out["opened_version"], "never above the newest version the series has")

	// the read: a stored value above the row's version is shown as the row's version
	idx.Versions = append(idx.Versions, seriesVersionRow{Digest: d[2], N: 3, Session: idx.Versions[0].Session, At: idx.Versions[0].At})
	require.NoError(t, writeSeriesIndex(dir, idx))
	_, err := k.h.db.ExecContext(context.Background(), `UPDATE artifact_series_opened SET version = 9`)
	require.NoError(t, err)
	_, list := p.get(t, "/api/team-artifacts?tag=for+review", nil)
	row := list["artifacts"].([]any)[0].(map[string]any)
	assert.EqualValues(t, 3, row["versions"])
	assert.EqualValues(t, 3, row["opened_version"], "a stored 9 is shown as the series' 3")
}

// 2. Deleting an artifact drops every person's star of it, not the owner key's alone.
func TestDeletingAnArtifactDropsEveryPersonsStarOfIt(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	_, d := threeVersions(t, k)
	ctx := context.Background()
	_, err := k.h.star(ctx, ownerPersonKey, d[2])
	require.NoError(t, err)
	_, err = k.h.star(ctx, "hub:org-1:u1", d[2])
	require.NoError(t, err)
	_, err = k.h.star(ctx, "hub:org-1:u2", d[2])
	require.NoError(t, err)
	_, err = k.h.star(ctx, "hub:org-1:u1", d[1]) // another version of the series: stays
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodDelete, "/api/artifacts/"+d[2], nil)
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	rc := chi.NewRouteContext()
	rc.URLParams.Add("id", d[2])
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	rec := httptest.NewRecorder()
	k.h.deleteAgentArtifact(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var n int
	require.NoError(t, k.h.db.Reader().GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_stars WHERE hex = ?", d[2]))
	assert.Zero(t, n, "the owner key's star")
	require.NoError(t, k.h.db.Reader().GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_person_stars WHERE hex = ?", d[2]))
	assert.Zero(t, n, "and every person's")
	require.NoError(t, k.h.db.Reader().GetContext(ctx, &n, "SELECT COUNT(*) FROM artifact_person_stars WHERE hex = ?", d[1]))
	assert.Equal(t, 1, n, "another version's star is not touched")
}

// 3. The privacy guard: what the Operator opened is not put on a row for an agent's token, nor a Hub caller that is not the owner (attachOpenedVersions asks starVisible).
func TestWhatTheOperatorOpenedIsNotPutOnARowForAnAgentToken(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	_, d := threeVersions(t, k)
	_, err := k.h.db.ExecContext(context.Background(), `INSERT INTO artifact_series_opened (person, board_id, series_id, version, opened_at) VALUES ('owner', 'alpha', ?, 2, '2026-11-06T10:00:00Z')`, mustSeriesOf(t, k, d[0]))
	require.NoError(t, err)
	_, list := p.get(t, "/api/team-artifacts?tag=for+review", nil)
	require.NotEmpty(t, list["artifacts"])
	raw, err := json.Marshal(list["artifacts"])
	require.NoError(t, err)
	var rowsFor []teamArtifact
	require.NoError(t, json.Unmarshal(raw, &rowsFor))
	for i := range rowsFor {
		rowsFor[i].SeriesID, rowsFor[i].OpenedVersion = "", 0
	}
	operator := httptest.NewRequest("GET", "/x", nil)
	p.bh.attachOpenedVersions(operator, rowsFor)
	require.NotEmpty(t, rowsFor[0].SeriesID, "the Operator's request gets the fields")
	assert.EqualValues(t, 2, rowsFor[0].OpenedVersion)
	for i := range rowsFor {
		rowsFor[i].SeriesID, rowsFor[i].OpenedVersion = "", 0
	}
	agent := withActor(httptest.NewRequest("GET", "/x", nil), Actor{Kind: ActorToken, Name: "Backend", Session: "s1"})
	p.bh.attachOpenedVersions(agent, rowsFor)
	assert.Empty(t, rowsFor[0].SeriesID, "an agent's token gets neither")
	assert.Zero(t, rowsFor[0].OpenedVersion)
	hub := httptest.NewRequest("GET", "/x", nil)
	hub.Header.Set(tunnel.ViaHeader, "x")
	p.bh.attachOpenedVersions(hub, rowsFor)
	assert.Empty(t, rowsFor[0].SeriesID, "nor a Hub caller with no owner stamp")
	assert.Zero(t, rowsFor[0].OpenedVersion)
}

func mustSeriesOf(t *testing.T, k *kindRig, digest string) string {
	t.Helper()
	sid, _, ok := digestSeries(k.coralDir, digest)
	require.True(t, ok)
	return sid
}
