package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #9841: a shortened artifact link (coral://artifacts/b801aafb…f5f) is made whole by the server that stores the text, or the text is refused with the way to fix it.

func shortRefHandler(t *testing.T, ids ...string) *BoardHandler {
	t.Helper()
	dir := t.TempDir()
	objects := filepath.Join(dir, "artifacts", "objects")
	require.NoError(t, os.MkdirAll(objects, 0o755))
	for _, id := range ids {
		require.Len(t, id, 64)
		require.NoError(t, os.WriteFile(filepath.Join(objects, id), []byte("x"), 0o644))
		require.NoError(t, os.WriteFile(filepath.Join(objects, id+".json"), []byte("{}"), 0o644)) // the sidecar is no second artifact
	}
	return &BoardHandler{coralDir: dir}
}

func hexID(prefix, suffix string) string {
	return prefix + strings.Repeat("0", 64-len(prefix)-len(suffix)) + suffix
}

func TestShortArtifactRefsAreMadeWholeOrRefused(t *testing.T) {
	a := hexID("b801aafb", "f5f")
	b := hexID("b801aafb", "9e1") // shares a's first eight digits
	c := hexID("5c0de1a2", "77d")
	h := shortRefHandler(t, a, b, c)
	r := httptest.NewRequest(http.MethodPost, "/api/board/x/messages", nil)
	expand := func(text string) (string, *shortRefProblem) { return h.expandShortArtifactRefs(r, text) }

	for _, tc := range []struct{ name, in, want string }{
		{"a prefix and the end", "see coral://artifacts/b801aafb…f5f now", "see coral://artifacts/" + a + " now"},
		{"three dots for the ellipsis", "see coral://artifacts/b801aafb...9e1.", "see coral://artifacts/" + b + "."},
		{"a prefix alone, when it is unique", "report: coral://artifacts/5c0de1a2", "report: coral://artifacts/" + c},
		{"a longer prefix names one of two", "coral://artifacts/b801aafb0…f5f", "coral://artifacts/" + a}, // 9 digits then the end
		{"two refs and the same one twice", "coral://artifacts/5c0de1a2…77d and coral://artifacts/b801aafb…9e1, again coral://artifacts/5c0de1a2…77d", "coral://artifacts/" + c + " and coral://artifacts/" + b + ", again coral://artifacts/" + c},
		{"a full link is left alone", "coral://artifacts/" + a, "coral://artifacts/" + a},
		{"a full link of an unknown artifact is left alone", "coral://artifacts/" + strings.Repeat("ab", 32), "coral://artifacts/" + strings.Repeat("ab", 32)},
		{"bare hex is not a ref", "shot b801aafb and artifact 5c0de1a2", "shot b801aafb and artifact 5c0de1a2"},
		{"seven digits is not a ref", "coral://artifacts/b801aaf", "coral://artifacts/b801aaf"},
		{"upper case is not a ref", "coral://artifacts/B801AAFB…F5F", "coral://artifacts/B801AAFB…F5F"},
		{"no link at all", "nothing to see", "nothing to see"},
	} {
		got, problem := expand(tc.in)
		require.Nil(t, problem, tc.name)
		assert.Equal(t, tc.want, got, tc.name)
	}

	_, p := expand("coral://artifacts/0123abcd…fff")
	require.NotNil(t, p)
	assert.Equal(t, "artifact_ref_unknown", p.code)
	assert.Contains(t, p.message, "coral://artifacts/0123abcd…fff")
	assert.Contains(t, p.message, "full 64-character link")

	_, p = expand("coral://artifacts/b801aafb")
	require.NotNil(t, p)
	assert.Equal(t, "artifact_ref_ambiguous", p.code)
	assert.Contains(t, p.message, a)
	assert.Contains(t, p.message, b)
	assert.Contains(t, p.message, "Add more characters")

	text := strings.Repeat("coral://artifacts/5c0de1a2 ", maxShortRefsInText+1)
	_, p = expand(text)
	require.NotNil(t, p)
	assert.Equal(t, "artifact_ref_too_many", p.code)
}

// The sender sees what the read rule gives it: the machine owner everything, an agent only what its team's owner owns, and no name is an oracle for an id the sender cannot read.
func TestShortArtifactRefsSeeOnlyWhatTheSenderMayRead(t *testing.T) {
	rig, _ := ownerRig(t)
	alice := rig.uploadText("a1", "alice.txt", "alice's text") // team-a, alice's
	bob := rig.uploadText("b1", "bob.txt", "bob's text")       // team-b, bob's
	h := &BoardHandler{coralDir: rig.coralDir}
	asAgent := func(session string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/board/team-a/messages", nil)
		return r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: session, SessionName: session}))
	}
	ref := func(id string) string { return "coral://artifacts/" + id[:8] + "…" + id[len(id)-3:] }

	owner := httptest.NewRequest(http.MethodPost, "/api/board/team-a/messages", nil) // no agent: the dashboard or the signed command line
	for _, id := range []string{alice, bob} {
		got, p := h.expandShortArtifactRefs(owner, ref(id))
		require.Nil(t, p)
		assert.Equal(t, "coral://artifacts/"+id, got, "the machine owner sees every artifact")
	}
	got, p := h.expandShortArtifactRefs(asAgent("a1"), ref(alice))
	require.Nil(t, p)
	assert.Equal(t, "coral://artifacts/"+alice, got, "an agent sees its team owner's")
	_, p = h.expandShortArtifactRefs(asAgent("a1"), ref(bob))
	require.NotNil(t, p, "an agent does not see another owner's artifact")
	assert.Equal(t, "artifact_ref_unknown", p.code, "and is told the same as for an artifact that does not exist")
	assert.NotContains(t, p.message, bob, "the refusal does not name it")
	_, p = h.expandShortArtifactRefs(asAgent("a1"), fmt.Sprintf("coral://artifacts/%s", bob[:8]))
	require.NotNil(t, p)
	assert.Equal(t, "artifact_ref_unknown", p.code)
}

// The dashboard's way to make a short ref in an old message a link: the Operator's read, one answer per ref, an id only when exactly one artifact matches.
func TestResolveShortArtifactRefsRoute(t *testing.T) {
	rig, _ := ownerRig(t)
	alice := rig.uploadText("a1", "alice.txt", "alice's text")
	bob := rig.uploadText("b1", "bob.txt", "bob's text")
	get := func(session string, links ...string) (int, string) {
		q := "?"
		for _, l := range links {
			q += "link=" + url.QueryEscape(l) + "&"
		}
		return rig.getAs(session, "/api/artifacts/resolve"+strings.TrimSuffix(q, "&"))
	}
	code, body := get("", "coral://artifacts/"+alice[:8]+"…"+alice[61:], bob[:8], "0123abcd…fff")
	require.Equal(t, http.StatusOK, code, body)
	var out struct {
		Refs []struct {
			Ref     string  `json:"ref"`
			ID      *string `json:"id"`
			Matches int     `json:"matches"`
		} `json:"refs"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	require.Len(t, out.Refs, 3)
	require.NotNil(t, out.Refs[0].ID)
	assert.Equal(t, alice, *out.Refs[0].ID)
	require.NotNil(t, out.Refs[1].ID)
	assert.Equal(t, bob, *out.Refs[1].ID, "the Operator sees every artifact, a bare prefix included")
	assert.Nil(t, out.Refs[2].ID)
	assert.Zero(t, out.Refs[2].Matches)

	code, _ = get("a1", alice[:8])
	assert.Equal(t, http.StatusForbidden, code, "an agent's token is not the dashboard")
	for _, bad := range []string{"", "abc", "zzzzzzzz", strings.Repeat("a", 64), "B801AAFB"} {
		code, _ = get("", bad)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	code, _ = rig.getAs("", "/api/artifacts/resolve")
	assert.Equal(t, http.StatusBadRequest, code, "no link at all")
}

// Through Coral Hub a short ref is the owner's alone (Security Reviewer's condition on #9841): a Hub member who is not the owner is refused exactly as for an artifact that does not exist,
// and never resolved against the owner's objects, in a post's text and in the resolve route; the owner of the same Hub gets the id.
func TestShortArtifactRefsThroughTheHubAreTheOwnersAlone(t *testing.T) {
	id := hexID("b801aafb", "f5f")
	h := shortRefHandler(t, id)
	short := "coral://artifacts/b801aafb…f5f"
	for _, c := range []struct {
		name   string
		header map[string]string
		label  string // the owner label this machine has enrolled ("" = none)
		owner  bool
	}{
		{"the owner through the hub", ownerHeaders(ownerLabel), ownerLabel, true},
		{"a grantee with no owner marker", granteeHeaders(), ownerLabel, false},
		{"the owner marker with no hub user", map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner"}, ownerLabel, false},
		{"the owner through a machine with no enrolled label", ownerHeaders(ownerLabel), "", false},
		{"the marker of a hub user that is not the enrolled owner", ownerHeaders("hub-user-9999ffff"), ownerLabel, false},
		{"two owner markers", map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: ownerLabel, tunnel.HubRoleHeader: "owner, owner"}, ownerLabel, false},
	} {
		withLabel(t, c.label, nil)
		r := httptest.NewRequest(http.MethodPost, "/api/board/x/messages", nil)
		for k, v := range c.header {
			r.Header.Set(k, v)
		}
		require.True(t, cloud.Tunneled(r), c.name+": the request is a tunneled one")
		got, problem := h.expandShortArtifactRefs(r, "see "+short)
		if c.owner {
			require.Nil(t, problem, c.name)
			assert.Equal(t, "see coral://artifacts/"+id, got, c.name)
			continue
		}
		require.NotNil(t, problem, c.name+": a Hub member who is not the owner resolves nothing")
		assert.Equal(t, "artifact_ref_unknown", problem.code, c.name)
		assert.NotContains(t, problem.message, id, c.name+": the refusal does not name it")
		assert.Empty(t, shortRefCandidates(r, h.coralDir, "b801aafb", ""), c.name+": not even a candidate")
	}
}

// The same through the resolve route, with the callers the artifact reads are tested with: the owner gets the id, anyone else is refused and the answer holds no id.
func TestResolveShortArtifactRefsThroughTheHubIsTheOwnersAlone(t *testing.T) {
	rig := uploadRig(t)
	code, up := rig.upload("s1", "note.txt", "text/plain", strings.NewReader("an agent's note"))
	require.Equal(t, http.StatusCreated, code, up)
	id := strings.TrimPrefix(up["uri"].(string), "coral://artifacts/")
	for _, c := range hubCallers() {
		withLabel(t, c.label, nil)
		status, body := hubGet(t, rig.srv.URL+"/api/artifacts/resolve?link="+id[:8], c.header)
		if c.allow {
			require.Equal(t, http.StatusOK, status, "%s: %s", c.name, body)
			assert.Contains(t, body, id, c.name)
			continue
		}
		assert.Equal(t, http.StatusForbidden, status, c.name)
		assert.NotContains(t, body, id, c.name)
	}
}
