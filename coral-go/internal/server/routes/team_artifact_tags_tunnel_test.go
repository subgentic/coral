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

// #8623: PUT /api/board/{project}/artifacts/{id}/tags has no tunnel row, so Coral Hub never forwards it; and a request that arrives with the connector's stamp anyway is still the owner's or refused: the
// handler's first act is refuseNonOwner. The handler has no board here: a request that got past the refusal would not be a 403.
func TestSetArtifactTagsRefusesATunneledNonOwner(t *testing.T) {
	withRecord(t, "team", teamOrgA, nil)
	h := &BoardHandler{}
	const id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for name, hdr := range map[string]http.Header{
		"a member of the organisation":      teamStamp(teamOrgA, "member", teamUIDA, teamUser),
		"an admin of another organisation":  teamStamp(teamOrgB, "admin", teamUIDA, teamUser),
		"a stamp with no role":              teamStamp(teamOrgA, "", teamUIDA, teamUser),
		"the stamp of a hub viewer, no uid": teamStamp(teamOrgA, "member", "", teamUser),
	} {
		req := httptest.NewRequest(http.MethodPut, "/api/board/alpha/artifacts/"+id+"/tags", nil)
		for k, vs := range hdr {
			req.Header[k] = vs
		}
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "alpha")
		rctx.URLParams.Add("id", id)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		require.NotPanics(t, func() { h.SetArtifactTags(rec, req) }, name)
		assert.Equal(t, http.StatusForbidden, rec.Code, name)
		assert.Equal(t, "owner_only", decodeStrings(t, rec.Body.String())["code"], name)
	}
}

// #12742: marking a file read on open is a tags write that the Hub's owner now makes through the tunnel. Through it only the owner is let in, and the body is closed to a-z, 0-9, space and hyphen; this computer's dashboard
// keeps the local rule.
func TestTheOwnerMarksAFileReadThroughTheHubAndNoOneElseCan(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	put := func(header map[string]string, body string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPut, e.srv.URL+"/api/board/tag-team/artifacts/"+id+"/tags", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		for k, v := range header {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	for _, c := range hubCallers() {
		withLabel(t, c.label, nil)
		code, out := put(c.header, `{"tags":["read"]}`)
		if c.allow {
			assert.Equal(t, http.StatusOK, code, "%s: %v", c.name, out)
		} else {
			assert.Equal(t, http.StatusForbidden, code, "%s: %v", c.name, out)
		}
	}
	// the stored tags are the owner's last word, and nobody else's call changed them
	all, err := e.h.bs.ArtifactTags(context.Background(), "tag-team")
	require.NoError(t, err)
	assert.Equal(t, []string{"read"}, all[id])

	// through the Hub the body is closed; each refusal is a 400 and changes nothing
	withLabel(t, ownerLabel, nil)
	hub := ownerHeaders(ownerLabel)
	for name, body := range map[string]string{
		"a letter outside a-z":    `{"tags":["café"]}`,
		"markup":                  `{"tags":["<b>"]}`,
		"a punctuation mark":      `{"tags":["read!"]}`,
		"25 characters":           `{"tags":["` + strings.Repeat("a", 25) + `"]}`,
		"six tags":                `{"tags":["a","b","c","d","e","f"]}`,
		"an empty tag":            `{"tags":[""]}`,
		"not JSON":                `read`,
		"a body that is not tags": `{"tags":"read"}`,
	} {
		code, out := put(hub, body)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}
	all, _ = e.h.bs.ArtifactTags(context.Background(), "tag-team")
	assert.Equal(t, []string{"read"}, all[id], "the refused bodies changed nothing")
	code, out := put(hub, `{"tags":["Read", "to-do 2", "a-z 09"]}`) // upper case is folded: a-z, 0-9, space, hyphen all pass
	assert.Equal(t, http.StatusOK, code, "%v", out)

	// this computer's own dashboard keeps the local rule: a letter outside a-z is a tag there
	code, out = put(map[string]string{testDashboardHeader: "1"}, `{"tags":["café"]}`)
	assert.Equal(t, http.StatusOK, code, "the local route is as it was: %v", out)
}

// Security's point 3 on #12742: through the Hub the closed rule is for the tags a request ADDS, judged against the list the server holds; a tag the artifact already has is kept whatever its letters (the page writes the whole
// list back to add "read"), and marking a file read is never refused for the count, while any other addition keeps the five-tag limit.
func TestThroughTheHubOnlyAddedTagsAreHeldToTheClosedRuleAndReadIsNeverCounted(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	withLabel(t, ownerLabel, nil)
	hub, dash := ownerHeaders(ownerLabel), map[string]string{testDashboardHeader: "1"}
	put := func(header map[string]string, body string) (int, map[string]any) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPut, e.srv.URL+"/api/board/tag-team/artifacts/"+id+"/tags", strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		for k, v := range header {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	stored := func() []string {
		all, err := e.h.bs.ArtifactTags(context.Background(), "tag-team")
		require.NoError(t, err)
		return all[id]
	}
	// the artifact has five tags, one of them with a letter outside a-z (set from this computer's own dashboard, where the local rule holds)
	code, out := put(dash, `{"tags":["for review","café","a","b","c"]}`)
	require.Equal(t, http.StatusOK, code, out)

	// marking it read: the page writes the whole list back with "read": six tags and a non-ASCII one that is already there
	code, out = put(hub, `{"tags":["for review","café","a","b","c","read"]}`)
	assert.Equal(t, http.StatusOK, code, "a read-only addition is accepted on an artifact that has five, and keeps what was there: %v", out)
	assert.ElementsMatch(t, []string{"for review", "café", "a", "b", "c", "read"}, stored())

	// removing a tag (the page settling an earlier version drops "for review") adds nothing
	code, out = put(hub, `{"tags":["café","a","b","c","read"]}`)
	assert.Equal(t, http.StatusOK, code, "%v", out)

	// any other addition is held to the rule: a new non-ASCII tag, and a sixth tag
	code, _ = put(hub, `{"tags":["café","a","b","c","read","naïve"]}`)
	assert.Equal(t, http.StatusBadRequest, code, "a new tag with a letter outside a-z is refused through the Hub")
	code, _ = put(hub, `{"tags":["café","a","b","c","read","extra"]}`)
	assert.Equal(t, http.StatusBadRequest, code, "a sixth tag that is not read keeps the five-tag limit")
	code, _ = put(hub, `{"tags":["café","a","b","c","read","read two"]}`)
	assert.Equal(t, http.StatusBadRequest, code, "only exactly read is the count's exception")
	assert.ElementsMatch(t, []string{"café", "a", "b", "c", "read"}, stored(), "the refusals changed nothing")
}

// QA's SHOULDs on #12742: a Hub write fails closed when the stored tags cannot be read (no list to judge "added" by: nothing is accepted), and repeated tags are stored once.
func TestAHubTagsWriteFailsClosedWhenTheStoredTagsCannotBeReadAndRepeatsAreOnce(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	withLabel(t, ownerLabel, nil)
	req, err := http.NewRequest(http.MethodPut, e.srv.URL+"/api/board/tag-team/artifacts/"+id+"/tags", strings.NewReader(`{"tags":["a","a","read","read"]}`))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range ownerHeaders(ownerLabel) {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode, "%v", out)
	assert.Equal(t, []any{"a", "read"}, out["tags"], "repeats are one tag")
	all, err := e.h.bs.ArtifactTags(context.Background(), "tag-team")
	require.NoError(t, err)
	assert.Equal(t, []string{"a", "read"}, all[id])

	require.NoError(t, e.h.bs.Close()) // the stored tags can no longer be read
	tags, err := e.h.hubArtifactTags(context.Background(), "tag-team", id, []string{"read"})
	assert.Error(t, err, "no stored list to judge by: refused, never accepted unchecked")
	assert.Nil(t, tags)
}
