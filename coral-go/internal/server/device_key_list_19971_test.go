package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #19971 (coral-hub #252527, Security's ruling on #19959): the trusted-device list for display, read through the Hub by the owner alone, GET only, at Launch, through the real router and the real stamp. Exactly the seven
// fields: no public key, no web_mode, no clock_notice. A grantee, a stamp with no account, a forged stamp and another account's owner role get nothing; the route cannot write.
func TestTheOwnersDeviceListThroughTheHubIsDisplayOnlyAndOwnerOnly(t *testing.T) {
	r := newE2ERemote(t, "device-key-list", nil)
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
	ss := store.NewSessionStore(r.db)
	kid := seedDevice(t, ss, 7, "interact")
	gone := seedDevice(t, ss, 8, "view")
	require.NoError(t, ss.RemoveDeviceKey(ctx, gone, store.DeviceRemoved, time.Now()))

	assert.Equal(t, tunnel.TierLaunch, tunnel.Classify("GET", "/api/device-keys/list", ""))
	for _, m := range []string{"POST", "PUT", "DELETE", "PATCH"} {
		assert.Equal(t, tunnel.TierNever, tunnel.Classify(m, "/api/device-keys/list", ""), m+" is not in the table")
	}

	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"}
	rec := call(h, "GET", "/api/device-keys/list", "", owner)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var out map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Len(t, out, 2, "the devices and the switch state (#21883)")
	assert.JSONEq(t, "false", string(out["require_trusted_device"]))
	var rows []map[string]any
	require.NoError(t, json.Unmarshal(out["devices"], &rows))
	require.Len(t, rows, 1, "the removed key is left out")
	assert.Equal(t, kid, rows[0]["kid"])
	allowed := map[string]bool{"kid": true, "label": true, "mode": true, "origin": true, "kind": true, "created_at": true, "last_used_at": true}
	for k := range rows[0] {
		assert.True(t, allowed[k], "a field that is not on the list: %s", k)
	}
	for _, k := range []string{"kid", "label", "mode", "origin", "kind", "created_at"} {
		assert.Contains(t, rows[0], k)
	}
	for _, banned := range []string{"pk", "public", "computer_pub", "web_mode", "clock_notice"} {
		assert.NotContains(t, rec.Body.String(), banned)
	}

	refused := map[string]map[string]string{
		"a grantee": {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "hub-user-9999ffff"},
		"the real stamp and no Hub account at all": {tunnel.ViaHeader: cloud.ViaSecret()},
		"the owner role for another account":       {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-9999ffff"},
		"a forged stamp":                           {tunnel.ViaHeader: "1"},
		"a forged stamp claiming the owner":        {tunnel.ViaHeader: "1", tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"},
	}
	for who, hdr := range refused {
		rec := call(h, "GET", "/api/device-keys/list", "", hdr)
		assert.Contains(t, []int{401, 403}, rec.Code, "%s must not read the list: %d %s", who, rec.Code, rec.Body.String())
		assert.NotContains(t, rec.Body.String(), kid, who)
	}
	for _, m := range []string{"POST", "PUT", "DELETE"} {
		assert.Contains(t, []int{403, 404, 405}, call(h, m, "/api/device-keys/list", `{}`, owner).Code, m)
	}
	keys, err := ss.ListDeviceKeys(ctx)
	require.NoError(t, err)
	active := 0
	for _, k := range keys {
		if k.RemovedAt == 0 {
			active++
		}
	}
	assert.Equal(t, 1, active, "the list route changed nothing")
}
