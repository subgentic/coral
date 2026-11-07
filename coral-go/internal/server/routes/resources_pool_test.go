package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13719 step 1: a pool through the routes. Only the Operator or an Orchestrator defines one; an agent claims it like any resource and is told which member (the machine) it holds; the list names the members and each holder's machine.
func TestAPoolIsDefinedClaimedAndListedWithTheMachineEachHolderGot(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.subscribe("alpha", "Dev B", "Developer", false)
	g.subscribe("alpha", "Dev C", "Developer", false)
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1, "machine": "Mac"})
	g.do("operator", "PUT", "/api/resources/mini", map[string]any{"slots": 1, "machine": "Mini"})
	code, _ := g.do("token:Dev A", "PUT", "/api/resources/heavy", map[string]any{"members": []string{"mac-heavy", "mini"}})
	assert.Equal(t, 403, code, "an agent that is not a manager cannot define a pool")
	code, v := g.do("operator", "PUT", "/api/resources/heavy", map[string]any{"members": []string{"mac-heavy", "mini"}})
	require.Equal(t, 200, code)
	assert.Equal(t, []any{"mac-heavy", "mini"}, v["members"])
	assert.EqualValues(t, 2, v["slots"], "the pool reads as the sum of its members' slots")
	code, _ = g.do("operator", "PUT", "/api/resources/bad", map[string]any{"members": []string{"nowhere"}})
	assert.Equal(t, 400, code, "an unknown member is refused")
	code, _ = g.do("operator", "PUT", "/api/resources/heavy2", map[string]any{"members": []string{"mini"}, "match": []string{"go test ./..."}})
	assert.Equal(t, 200, code, "a pool may carry a match (#13751): the hook claims it")
	code, _ = g.do("operator", "PUT", "/api/resources/bad3", map[string]any{"members": []string{"mini"}, "slots": 4})
	assert.Equal(t, 400, code)

	code, a := g.do("token:Dev A", "POST", "/api/resources/heavy/claim", map[string]any{})
	require.Equal(t, 200, code)
	entry := a["entry"].(map[string]any)
	assert.Equal(t, "mac-heavy", entry["member"])
	assert.Equal(t, "Mac", entry["machine"], "the claim's answer says which machine")
	code, b := g.do("token:Dev B", "POST", "/api/resources/heavy/claim", map[string]any{})
	require.Equal(t, 200, code)
	assert.Equal(t, "mini", b["entry"].(map[string]any)["member"])
	code, cc := g.do("token:Dev C", "POST", "/api/resources/heavy/claim", map[string]any{})
	assert.Equal(t, 202, code)
	assert.EqualValues(t, 1, cc["place"])

	_, list := g.do("operator", "GET", "/api/resources", nil)
	by := map[string]map[string]any{}
	for _, r := range list["resources"].([]any) {
		rv := r.(map[string]any)
		by[rv["name"].(string)] = rv
	}
	require.Contains(t, by, "heavy")
	assert.Len(t, by["heavy"]["holders"].([]any), 2)
	h := by["heavy"]["holders"].([]any)[1].(map[string]any)
	assert.Equal(t, "Mini", h["machine"])
	assert.Len(t, by["mini"]["holders"].([]any), 1, "the member's own list shows the pool's hold on it")
	assert.NotContains(t, by["mini"], "members")

	// the single-resource answer (what coral-board resource status reads) names the machine too
	_, one := g.do("operator", "GET", "/api/resources/heavy", nil)
	oneHolders := one["holders"].([]any)
	require.Len(t, oneHolders, 2)
	assert.Equal(t, "Mini", oneHolders[1].(map[string]any)["machine"])

	code, _ = g.do("operator", "DELETE", "/api/resources/mini", nil)
	assert.Equal(t, 409, code, "a resource in a pool is not removed from under it: told as a conflict")
}

// #14354: where a run through a resource happens is defined by the Operator or an Orchestrator (here, remote or nothing), and the claim's answer carries it: for a pool's grant the member's, for a plain
// resource its own. Anything else is refused.
func TestAResourceIsDefinedHereOrRemoteAndAClaimCarriesIt(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.subscribe("alpha", "Dev B", "Developer", false)
	code, _ := g.do("operator", "PUT", "/api/resources/box", map[string]any{"slots": 1, "where": "elsewhere"})
	assert.Equal(t, 400, code, "only here or remote")
	code, _ = g.do("token:Dev A", "PUT", "/api/resources/box", map[string]any{"slots": 1, "where": "remote"})
	assert.Equal(t, 403, code, "an agent that is not a manager cannot say where a resource runs")
	code, v := g.do("operator", "PUT", "/api/resources/near", map[string]any{"slots": 1, "machine": "Mac", "where": "here"})
	require.Equal(t, 200, code)
	assert.Equal(t, "here", v["where"])
	code, _ = g.do("operator", "PUT", "/api/resources/far", map[string]any{"slots": 1, "machine": "Far", "where": "remote"})
	require.Equal(t, 200, code)
	code, _ = g.do("operator", "PUT", "/api/resources/silent", map[string]any{"slots": 1, "machine": "Epoch"})
	require.Equal(t, 200, code)
	code, _ = g.do("operator", "PUT", "/api/resources/both", map[string]any{"members": []string{"near", "far"}})
	require.Equal(t, 200, code)

	// a plain resource's claim carries its own where; one that says nothing carries none
	code, a := g.do("token:Dev A", "POST", "/api/resources/silent/claim", map[string]any{})
	require.Equal(t, 200, code)
	assert.NotContains(t, a["entry"].(map[string]any), "where", "a resource that says nothing: nothing is carried")
	code, _ = g.do("token:Dev A", "POST", "/api/resources/silent/release", map[string]any{})
	require.Equal(t, 200, code)
	code, b := g.do("token:Dev A", "POST", "/api/resources/far/claim", map[string]any{})
	require.Equal(t, 200, code)
	assert.Equal(t, "remote", b["entry"].(map[string]any)["where"])
	code, _ = g.do("token:Dev A", "POST", "/api/resources/far/release", map[string]any{})
	require.Equal(t, 200, code)
	// a pool's grant carries the member's
	code, c := g.do("token:Dev A", "POST", "/api/resources/both/claim", map[string]any{})
	require.Equal(t, 200, code)
	assert.Equal(t, "near", c["entry"].(map[string]any)["member"])
	assert.Equal(t, "here", c["entry"].(map[string]any)["where"])
	code, d := g.do("token:Dev B", "POST", "/api/resources/both/claim", map[string]any{})
	require.Equal(t, 200, code)
	assert.Equal(t, "far", d["entry"].(map[string]any)["member"])
	assert.Equal(t, "remote", d["entry"].(map[string]any)["where"])
}
