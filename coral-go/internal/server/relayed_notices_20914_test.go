package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20914 (for #20909): the feed of what a Hub's owner gave through a Hub, and a Revoke that only the person at this computer can press. Contract: coral://artifacts/81f00bde...

type noticeRow struct {
	GrantID   string `json:"grant_id"`
	State     string `json:"state"`
	Level     string `json:"level"`
	Person    string `json:"person"`
	HubUser   string `json:"hub_user"`
	LinkID    string `json:"link_id"`
	SignedBy  string `json:"signed_by"`
	Device    string `json:"device"`
	Via       string `json:"via"`
	RevokedBy string `json:"revoked_by"`
	Team      struct {
		ID string `json:"id"`
	} `json:"team"`
}

func feed(t *testing.T, g *grantRig, q string) (int, []noticeRow, string) {
	t.Helper()
	rec := call(g.d.r.srv.Router(), "GET", "/api/relayed-grant-notices"+q, "", nil)
	var out struct {
		Notices []noticeRow `json:"notices"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out.Notices, rec.Body.String()
}

func TestTheFeedListsWhatAHubGaveAndRevokeEndsItHere(t *testing.T) {
	g := newGrantRig(t)
	body := g.grantBody(g.owner, g.ownK, viewGrant(testLinkID), nil)
	require.Equal(t, 200, g.post(g.owner, g.ownK, relayOwner, teamGrants, body, nil).Code)

	code, rows, raw := feed(t, g, "")
	require.Equal(t, 200, code, raw)
	require.Len(t, rows, 1)
	r := rows[0]
	assert.Equal(t, "live", r.State)
	assert.Equal(t, "view", r.Level)
	assert.Equal(t, "hub", r.Via, "it came through a Hub")
	assert.Equal(t, testLinkID, r.LinkID)
	assert.Equal(t, "hub-user-cccc3333", r.HubUser)
	assert.Equal(t, "team1", r.Team.ID)
	assert.Equal(t, g.ownK[:8], r.SignedBy, "the key shows as its first 8 characters")
	assert.Equal(t, "Ada from Acme", r.Person)
	assert.NotContains(t, raw, g.ownK, "never the whole key id")

	// The state filter is an enum.
	assert.Equal(t, 400, call(g.d.r.srv.Router(), "GET", "/api/relayed-grant-notices?state=bogus", "", nil).Code)

	// Revoke here ends it at once, twice is the same answer, an unknown id is 404.
	h := g.d.r.srv.Router()
	rec := call(h, "POST", "/api/relayed-grant-notices/"+r.GrantID+"/revoke", "", nil)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"state":"revoked"`)
	assert.Empty(t, g.rows(), "no live grant is left")
	assert.Equal(t, 200, call(h, "POST", "/api/relayed-grant-notices/"+r.GrantID+"/revoke", "", nil).Code, "idempotent")
	assert.Equal(t, 404, call(h, "POST", "/api/relayed-grant-notices/mg-0000000000000000/revoke", "", nil).Code)
	assert.Equal(t, 404, call(h, "POST", "/api/relayed-grant-notices/nope/revoke", "", nil).Code)

	_, rows, _ = feed(t, g, "")
	require.Len(t, rows, 1)
	assert.Equal(t, "revoked", rows[0].State)
	assert.Equal(t, "this computer", rows[0].RevokedBy)
	_, live, _ := feed(t, g, "?state=live")
	assert.Empty(t, live)
}

func TestTheFeedAndRevokeAreRefusedThroughAHubAndToAnAgent(t *testing.T) {
	g := newGrantRig(t)
	body := g.grantBody(g.owner, g.ownK, viewGrant(testLinkID), nil)
	require.Equal(t, 200, g.post(g.owner, g.ownK, relayOwner, teamGrants, body, nil).Code)
	_, rows, _ := feed(t, g, "")
	require.Len(t, rows, 1)
	id := rows[0].GrantID

	assert.Equal(t, tunnel.TierNever, tunnel.Classify("GET", "/api/relayed-grant-notices", ""))
	assert.Equal(t, tunnel.TierNever, tunnel.Classify("POST", "/api/relayed-grant-notices/"+id+"/revoke", ""))

	h := g.d.r.srv.Router()
	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: relayOwner, tunnel.LinkHeader: testLinkID}
	for _, c := range [][2]string{{"GET", "/api/relayed-grant-notices"}, {"POST", "/api/relayed-grant-notices/" + id + "/revoke"}} {
		rec := call(h, c[0], c[1], "", owner)
		assert.Contains(t, []int{403, 404}, rec.Code, "%s %s through a Hub: %d", c[0], c[1], rec.Code)
		assert.NotContains(t, rec.Body.String(), id)
	}
	assert.Len(t, g.rows(), 1, "nothing was revoked through a Hub")
}

func TestTheFeedAndRevokeAreRefusedToAnAgentToken(t *testing.T) {
	srv, ts, _ := strictServer(t, true)
	tok, err := srv.db.MintSessionToken(context.Background(), "sid-dev", "claude-dev")
	require.NoError(t, err)
	for _, c := range [][2]string{{"GET", "/api/relayed-grant-notices"}, {"POST", "/api/relayed-grant-notices/mg-0000000000000000/revoke"}} {
		req, _ := http.NewRequest(c[0], ts.URL+c[1], strings.NewReader(""))
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		assert.Equal(t, 403, resp.StatusCode, c[0]+" "+c[1]+": "+string(b))
	}
}
