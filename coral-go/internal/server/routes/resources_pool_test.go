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
