package server

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20903 (coral-hub #20897): the owner reads, through the Hub, which link a request arrived on (lnk-<8 hex>), so the Hub can build the v3 signed text. Owner only, GET only, Launch tier; nothing is stored; a local call gets 404.
func TestTheOwnerReadsTheArrivalLinkThroughTheHub(t *testing.T) {
	r := newE2ERemote(t, "device-key-link", nil)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	ctx := t.Context()
	r.srv.cloudHandler.SetLinkedCheck(func() bool { return true })
	cs := store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.cfg.CoralDir()))
	require.NoError(t, cs.Save(ctx, "https://hub.example.invalid", "srv_1", "L", "coralhub_srv_abcd1234_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"))
	pinned, err := cs.PinOwnerUser(ctx, "srv_1", "hub-user-1234abcd")
	require.NoError(t, err)
	require.True(t, pinned)
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"launch"}`, js).Code)

	assert.Equal(t, tunnel.TierLaunch, tunnel.Classify("GET", "/api/device-keys/link", ""))
	for _, m := range []string{"POST", "PUT", "DELETE", "PATCH"} {
		assert.Equal(t, tunnel.TierNever, tunnel.Classify(m, "/api/device-keys/link", ""), m+" is not in the table")
	}

	lk, err := cs.LinkByOrigin(ctx, "https://hub.example.invalid")
	require.NoError(t, err)
	link := lk.LinkID
	require.True(t, tunnel.ValidLinkID(link))
	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd", tunnel.LinkHeader: link}
	rec := call(h, "GET", "/api/device-keys/link", "", owner)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var out map[string]string
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, map[string]string{"link": link}, out, "exactly the link")

	refused := map[string]map[string]string{
		"a grantee": {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "hub-user-9999ffff", tunnel.LinkHeader: link},
		"the real stamp and no Hub account at all": {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: link},
		"the owner role for another account":       {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-9999ffff", tunnel.LinkHeader: link},
		"a forged stamp":                           {tunnel.ViaHeader: "1", tunnel.LinkHeader: link},
	}
	for who, hdr := range refused {
		rec := call(h, "GET", "/api/device-keys/link", "", hdr)
		assert.Contains(t, []int{401, 403}, rec.Code, "%s must not read the link: %d %s", who, rec.Code, rec.Body.String())
		assert.NotContains(t, rec.Body.String(), link, who)
	}
	for _, m := range []string{"POST", "PUT", "DELETE"} {
		assert.Contains(t, []int{403, 404, 405}, call(h, m, "/api/device-keys/link", `{}`, owner).Code, m)
	}
	// A local call has no link: 404, nothing in the body.
	local := call(h, "GET", "/api/device-keys/link", "", nil)
	assert.Equal(t, 404, local.Code, local.Body.String())
	assert.NotContains(t, local.Body.String(), "lnk-")
}
