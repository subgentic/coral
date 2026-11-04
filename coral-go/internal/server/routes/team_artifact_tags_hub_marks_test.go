package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #13450 (Security's spec, #169160): through Coral Hub the owner may add or remove THREE fixed marks on a file, "read", "saved" and "ignored" (the owner's Save and Ignore in the Needs you table drawn on the Hub); any
// other difference from the stored list is refused and nothing is stored; a tag the write does not name is never dropped; a sixth tag is refused when saved or ignored is added (a lone read is never refused for the
// count); the same tags in another order change nothing; a grantee, a viewer and a guide are refused outright (the machine, before the handler).
func TestAHubTagsWriteMayAddOrRemoveReadSavedAndIgnoredForTheOwnerAlone(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	withLabel(t, ownerLabel, nil)
	owner, dash := ownerHeaders(ownerLabel), map[string]string{testDashboardHeader: "1"}
	put := func(header map[string]string, tags ...string) (int, map[string]any) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"tags": tags})
		req, err := http.NewRequest(http.MethodPut, e.srv.URL+"/api/board/tag-team/artifacts/"+id+"/tags", strings.NewReader(string(b)))
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
	code, out := put(dash, "for review", "a")
	require.Equal(t, http.StatusOK, code, out)
	base := stored()

	// the owner adds saved, then ignored, then read; each goes on the end, what was there keeps its order
	code, out = put(owner, "for review", "a", "saved")
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.ElementsMatch(t, append(append([]string{}, base...), "saved"), stored())
	code, out = put(owner, "for review", "a", "saved", "ignored")
	assert.Equal(t, http.StatusOK, code, "%v", out)
	code, out = put(owner, "for review", "a", "saved", "ignored", "read")
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.ElementsMatch(t, []string{"for review", "a", "saved", "ignored", "read"}, stored()) // the store lists them sorted
	// the same tags in another order, and a repeat: no change
	before := stored()
	code, _ = put(owner, "read", "ignored", "saved", "a", "for review")
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, before, stored(), "a reorder changes nothing")
	// removes each
	for _, drop := range []string{"saved", "ignored", "read"} {
		var keep []string
		for _, t := range stored() {
			if t != drop {
				keep = append(keep, t)
			}
		}
		code, out = put(owner, keep...)
		assert.Equal(t, http.StatusOK, code, "removing %s: %v", drop, out)
		assert.NotContains(t, stored(), drop)
	}
	assert.Equal(t, base, stored())

	// another word is refused, and nothing is stored
	for name, tags := range map[string][]string{
		"adding another tag":    {"for review", "a", "approved"},
		"saved and another":     {"for review", "a", "saved", "approved"},
		"a look-alike":          {"for review", "a", "saved ", "ignore"},
		"removing another tag":  {"for review"},
		"removing every tag":    {},
		"replacing one tag":     {"for review", "b", "saved"},
		"saved, dropping other": {"a", "saved"},
	} {
		code, out := put(owner, tags...)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
		assert.Equal(t, base, stored(), "%s changed the stored tags", name)
	}

	// a sixth tag is refused when saved or ignored is added; a lone read is never refused for the count
	code, _ = put(dash, "a", "b", "c", "d", "e")
	require.Equal(t, http.StatusOK, code)
	five := stored()
	for _, mark := range []string{"saved", "ignored"} {
		code, out = put(owner, "a", "b", "c", "d", "e", mark)
		assert.Equal(t, http.StatusBadRequest, code, "a sixth tag (%s) is refused: %v", mark, out)
		assert.Equal(t, five, stored())
	}
	code, _ = put(owner, "a", "b", "c", "d", "e", "read")
	assert.Equal(t, http.StatusOK, code, "read alone is never refused for the count")
	// with one slot free, saved is taken
	code, _ = put(dash, "a", "b", "c", "d")
	require.Equal(t, http.StatusOK, code)
	code, _ = put(owner, "a", "b", "c", "d", "saved")
	assert.Equal(t, http.StatusOK, code, "the fifth tag is allowed")

	// not the owner: the machine refuses the whole write, before the handler, and nothing is stored
	viewer := func() map[string]string { m := granteeHeaders(); m[tunnel.HubRoleHeader] = "viewer"; return m }
	guide := func() map[string]string {
		m := granteeHeaders()
		m[tunnel.HubRoleHeader] = tunnel.HubRoleGuide
		m[tunnel.HubGuideBoardHeader] = "tag-team"
		m[tunnel.HubGuideLabelHeader] = "Reviewer"
		return m
	}
	afterFive := stored()
	for name, hdr := range map[string]map[string]string{"grantee": granteeHeaders(), "viewer": viewer(), "guide": guide()} {
		for _, tags := range [][]string{append(append([]string{}, afterFive...), "ignored"), {"read"}} {
			code, out := put(hdr, tags...)
			assert.Equal(t, http.StatusForbidden, code, "%s: %v", name, out)
		}
		assert.Equal(t, afterFive, stored(), name+" changed the stored tags")
	}
}
