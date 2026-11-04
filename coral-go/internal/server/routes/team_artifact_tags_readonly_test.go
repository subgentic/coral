package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13117 (coral-hub's #12742): the tags of a file are this computer's. A write that came through Coral Hub may only ADD or REMOVE "read" (the Hub passes the computer's read mark through); any other difference from the
// list the server holds is a 400 and nothing is stored. A write from this computer's own dashboard is unchanged.
func TestAHubTagsWriteMayOnlyAddOrRemoveRead(t *testing.T) {
	e := newTagEnv(t)
	id := e.ids["report.md"]
	withLabel(t, ownerLabel, nil)
	hub, dash := ownerHeaders(ownerLabel), map[string]string{testDashboardHeader: "1"}
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
	// this computer sets the tags: any list, including a tag with a letter outside a-z
	code, out := put(dash, "for review", "café", "a")
	require.Equal(t, http.StatusOK, code, out)
	base := stored()
	require.ElementsMatch(t, []string{"for review", "café", "a"}, base)

	// add read: ok, and what was there is kept in its order
	code, out = put(hub, "for review", "café", "a", "read")
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, append(append([]string{}, base...), "read"), stored())
	// the same list again, and the same tags in another order: allowed, and stored as it was (a reorder is no change)
	code, _ = put(hub, "for review", "café", "a", "read")
	assert.Equal(t, http.StatusOK, code, "a repeat of the stored list is a no-op")
	before := stored()
	code, _ = put(hub, "read", "a", "café", "for review")
	assert.Equal(t, http.StatusOK, code, "a reorder is a no-op")
	assert.Equal(t, before, stored(), "a reorder through the Hub never changes the stored order")
	code, _ = put(hub, "Read", "a", "café", "for review")
	assert.Equal(t, http.StatusOK, code, "upper case is folded: it is read")

	// anything else is refused and changes nothing
	for name, tags := range map[string][]string{
		"adding another tag":               {"for review", "café", "a", "read", "approved"},
		"adding another tag, nothing else": {"approved"},
		"removing another tag":             {"café", "a", "read"},
		"removing every tag":               {},
		"replacing one tag":                {"for review", "café", "b", "read"},
		"adding read-like text":            {"for review", "café", "a", "read", "read two"},
		"read and another add together":    {"for review", "café", "a", "read", "x"},
	} {
		code, out := put(hub, tags...)
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
		assert.Equal(t, before, stored(), "%s changed the stored tags", name)
	}
	// remove read together with another removal or addition: refused
	code, _ = put(hub, "café", "a")
	assert.Equal(t, http.StatusBadRequest, code, "dropping read and for review in one write")
	code, _ = put(hub, "for review", "café", "a", "approved")
	assert.Equal(t, http.StatusBadRequest, code, "swapping read for another tag")
	assert.Equal(t, before, stored())

	// remove read: ok
	code, out = put(hub, "for review", "café", "a")
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.ElementsMatch(t, base, stored())
	// removing read when it is not there is a no-op
	code, _ = put(hub, "for review", "café", "a")
	assert.Equal(t, http.StatusOK, code)

	// marking read is never refused for the count: an artifact with five tags still takes read
	code, _ = put(dash, "a", "b", "c", "d", "e")
	require.Equal(t, http.StatusOK, code)
	code, _ = put(hub, "a", "b", "c", "d", "e", "read")
	assert.Equal(t, http.StatusOK, code)
	// an artifact with no tags takes read, and read alone can be taken off
	code, _ = put(dash)
	require.Equal(t, http.StatusOK, code)
	code, _ = put(hub, "read")
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{"read"}, stored())
	code, _ = put(hub)
	assert.Equal(t, http.StatusOK, code)
	assert.Empty(t, stored())

	// this computer's own dashboard is unchanged: any replacement
	code, out = put(dash, "approved", "naïve", "x")
	assert.Equal(t, http.StatusOK, code, "%v", out)
	assert.ElementsMatch(t, []string{"approved", "naïve", "x"}, stored())
}
