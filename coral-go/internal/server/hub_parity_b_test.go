package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Hub parity batch B (#20258): the 8 small writes are the owner's alone through the Hub, and each takes a closed body there: a key the route does not list is 400 body_key_not_allowed, a body over the route's size is 413,
// a body that is not one JSON object is 400, and a body the route takes reaches the handler (whatever it answers: these are the handlers' own answers, not the Hub's).
func TestHubParityBWritesAreTheOwnersAloneWithAClosedBody(t *testing.T) {
	r := newE2ERemote(t, "parity-b", nil)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"interact"}`, js).Code)
	const o = "hub-user-1234abcd"
	routes.SetHubOwnerLabel(func(context.Context) (string, error) { return o, nil })
	t.Cleanup(func() { routes.SetHubOwnerLabel(nil) })
	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: o, "Content-Type": "application/json"}
	hub := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	codeOf := func(body string) string {
		var out map[string]any
		_ = json.Unmarshal([]byte(body), &out)
		c, _ := out["code"].(string)
		return c
	}
	for _, c := range []struct {
		method, path, body string
		limit              int
	}{
		{"POST", "/api/agents/models/refresh?type=claude", ``, 16 << 10},
		{"POST", "/api/folder-tags/x", `{"tag_id":1}`, 16 << 10},
		{"POST", "/api/sessions/history/abc/tags", `{"tag_id":1}`, 16 << 10},
		{"POST", "/api/sessions/live/x/tasks/reorder", `{"task_ids":[1]}`, 16 << 10},
		{"POST", "/api/sessions/live/x/waiting/dismiss", `{"agent_type":"claude","session_id":"s","through_id":1}`, 16 << 10},
		{"POST", "/api/tags", `{"name":"t","color":"#112233"}`, 16 << 10},
		{"PUT", "/api/sessions/history/abc/notes", `{"notes_md":"n"}`, 256 << 10},
		{"PUT", "/api/themes/zz", `{"description":"d","base":"dark","variables":{}}`, 64 << 10},
	} {
		name := c.method + " " + c.path
		// someone through the Hub who is not the owner: refused before the body is read
		rec := call(h, c.method, c.path, c.body, hub)
		assert.Equal(t, 403, rec.Code, name)
		assert.Equal(t, "owner_only", codeOf(rec.Body.String()), name)
		// the owner, with a key the route does not list
		rec = call(h, c.method, c.path, `{"zz_not_a_key":1}`, owner)
		assert.Equal(t, 400, rec.Code, name+": "+rec.Body.String())
		assert.Equal(t, "body_key_not_allowed", codeOf(rec.Body.String()), name)
		// a body that is not one object
		rec = call(h, c.method, c.path, `[1]`, owner)
		assert.Equal(t, 400, rec.Code, name)
		assert.Equal(t, "body_not_an_object", codeOf(rec.Body.String()), name)
		// a body over the route's size
		rec = call(h, c.method, c.path, `{"x":"`+strings.Repeat("a", c.limit)+`"}`, owner)
		assert.Equal(t, 413, rec.Code, name)
		assert.Equal(t, "body_too_large", codeOf(rec.Body.String()), name)
		// the body the route takes reaches the handler: its answer is the handler's own
		rec = call(h, c.method, c.path, c.body, owner)
		switch codeOf(rec.Body.String()) {
		case "owner_only", "body_key_not_allowed", "body_not_an_object", "body_too_large", "hub_route_refused":
			assert.Failf(t, "the owner's valid request was refused by the Hub's own checks", "%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
}
