package server

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

const grantPerson = "hub-user-bbbb2222"

// #20387 S1 (Security 5a-c): a grant is written, listed and revoked only by the person at this computer, never exceeds the cap of the link it names, and is keyed by (link, Hub person).
func TestMemberGrantsAreTheOperatorsAtThisComputerAndBoundedByTheLinkCap(t *testing.T) {
	ctx := context.Background()
	r, cs, l := linkedRemote(t, &fakeRevoker{})
	h := r.srv.Router()
	_, err := r.srv.boardStore.Subscribe(ctx, "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	js := map[string]string{"Content-Type": "application/json"}
	path := "/api/board/team1/member-grants"
	body := func(level string) string {
		return `{"link_id":"` + l.LinkID + `","hub_user":"` + grantPerson + `","level":"` + level + `","label":"Ada from Acme","days":7}`
	}
	count := func() int { gs, _ := r.srv.boardStore.ListMemberGrants(ctx, "", time.Now()); return len(gs) }

	// The link's cap is view: a team grant would exceed it and is refused; a view grant is not.
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"view"}`, js).Code)
	rec := call(h, "POST", path, body("team"), js)
	assert.Equal(t, 400, rec.Code, rec.Body.String())
	assert.Zero(t, count(), "a refused grant wrote nothing")

	// An unknown link is refused.
	rec = call(h, "POST", path, `{"link_id":"lnk-00000000","hub_user":"`+grantPerson+`","level":"view","label":"Ada"}`, js)
	assert.Equal(t, 400, rec.Code)

	// A field the route does not take (a Hub's idea of the grant, a different board) is refused.
	rec = call(h, "POST", path, `{"link_id":"`+l.LinkID+`","hub_user":"`+grantPerson+`","level":"view","label":"Ada","board_id":"other"}`, js)
	assert.Equal(t, 400, rec.Code)

	rec = call(h, "POST", path, body("view"), js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var g struct {
		GrantID string `json:"grant_id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &g))
	live, err := r.srv.boardStore.MemberGrantLive(ctx, l.LinkID, grantPerson, "team1", time.Now())
	require.NoError(t, err)
	assert.Equal(t, g.GrantID, live.GrantID)
	assert.Equal(t, "view", live.Level)

	// Raising the cap allows a team grant for another person; lowering it afterwards does not change what was written (the use-time check is S2's).
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"interact"}`, js).Code)
	rec = call(h, "POST", path, `{"link_id":"`+l.LinkID+`","hub_user":"hub-user-cccc3333","level":"team","label":"Bo"}`, js)
	require.Equal(t, 200, rec.Code, rec.Body.String())

	list := call(h, "GET", path, "", js)
	require.Equal(t, 200, list.Code)
	assert.Contains(t, list.Body.String(), g.GrantID)

	// A grant is ended only through its own team's path.
	assert.Equal(t, 404, call(h, "DELETE", "/api/board/other/member-grants/"+g.GrantID, "", js).Code)
	assert.Equal(t, 200, call(h, "DELETE", path+"/"+g.GrantID, "", js).Code)
	assert.Equal(t, 404, call(h, "DELETE", path+"/"+g.GrantID, "", js).Code, "a second revoke finds nothing")
	_, err = r.srv.boardStore.MemberGrantLive(ctx, l.LinkID, grantPerson, "team1", time.Now())
	assert.Error(t, err, "revoked at once")
	_ = cs
}

// Security 5b: through a Hub, at any mode and for any role, and by an agent or a script, a grant route changes nothing.
func TestNoHubAndNoAgentCanWriteAMemberGrant(t *testing.T) {
	ctx := context.Background()
	r, _, l := linkedRemote(t, &fakeRevoker{})
	h := r.srv.Router()
	_, err := r.srv.boardStore.Subscribe(ctx, "team1", "Dev", "Backend Dev", "s", nil, "")
	require.NoError(t, err)
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"launch"}`, map[string]string{"Content-Type": "application/json"}).Code)
	body := `{"link_id":"` + l.LinkID + `","hub_user":"` + grantPerson + `","level":"view","label":"Ada"}`
	hub := func(role string) map[string]string {
		return map[string]string{"Content-Type": "application/json", tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: l.LinkID, tunnel.ActorHeader: grantPerson, tunnel.HubRoleHeader: role, tunnel.HubUserHeader: grantPerson}
	}
	for _, role := range []string{"owner", "guide", "member", ""} {
		for _, rt := range [][2]string{{"POST", "/api/board/team1/member-grants"}, {"GET", "/api/board/team1/member-grants"}, {"DELETE", "/api/board/team1/member-grants/mg-0000000000000000"}} {
			rec := call(h, rt[0], rt[1], body, hub(role))
			assert.Equal(t, http.StatusForbidden, rec.Code, role+" "+rt[0]+" "+rec.Body.String())
		}
	}
	// A script with a session token header (an agent) is not the person.
	rec := call(h, "POST", "/api/board/team1/member-grants", body, map[string]string{"Content-Type": "application/json", store.SessionTokenHeader: "x"})
	assert.NotEqual(t, 200, rec.Code, rec.Body.String())
	gs, err := r.srv.boardStore.ListMemberGrants(ctx, "", time.Now())
	require.NoError(t, err)
	assert.Empty(t, gs, "nothing was written")
}
