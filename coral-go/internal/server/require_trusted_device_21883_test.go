package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21883: "Require a trusted device for Hub actions" is off by default and set only by the person at this computer: never through the tunnel, never by an agent's token, not by PUT /api/settings, and not while no
// trusted device exists. The Hub reads its state from the device list.
func TestRequireTrustedDeviceSwitch(t *testing.T) {
	require.Equal(t, tunnel.TierNever, tunnel.Classify("PUT", "/api/cloud/hub-require-trusted-device", ""))
	r := newE2ERemote(t, "require-device", nil)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	hub := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	agent := map[string]string{store.SessionTokenHeader: "any-token", "Content-Type": "application/json"}
	ss := store.NewSessionStore(r.db)
	status := func() map[string]any {
		rec := call(h, "GET", "/api/cloud/status", "", nil)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		var m map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &m))
		return m
	}
	assert.Equal(t, false, status()["require_trusted_device"], "off by default")

	rec := call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{"require":true}`, js)
	assert.Equal(t, 409, rec.Code, "no trusted device yet: "+rec.Body.String())
	assert.Contains(t, rec.Body.String(), "no_trusted_device")
	assert.Equal(t, false, status()["require_trusted_device"])

	// A key added without proof (the upgrade path) is not a trusted device: a broken-into Hub could have planted it.
	pk := make([]byte, 65)
	pk[0], pk[1] = 0x04, 99
	sum := sha256.Sum256(pk)
	_, err := ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: base64.RawURLEncoding.EncodeToString(sum[:]), PK: pk, Label: "Planted", Mode: "interact", Origin: store.DeviceOriginNoProof, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner}, time.Now())
	require.NoError(t, err)
	rec = call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{"require":true}`, js)
	assert.Equal(t, 409, rec.Code, "a no-proof key does not count: "+rec.Body.String())
	assert.Contains(t, rec.Body.String(), "no_trusted_device")

	seedDevice(t, ss, 11, "interact")
	assert.Equal(t, 400, call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{}`, js).Code, "require is required")
	for _, m := range []string{"view", "interact", "launch"} {
		require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"`+m+`"}`, js).Code)
		assert.Equal(t, 403, call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{"require":false}`, hub).Code, "never through the tunnel (%s)", m)
	}
	assert.Equal(t, 403, call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{"require":true}`, agent).Code, "an agent's token is refused")
	assert.Equal(t, 400, call(h, "PUT", "/api/settings", `{"hub_require_trusted_device":"true"}`, js).Code, "the settings route refuses the key")
	assert.Equal(t, false, status()["require_trusted_device"], "none of that changed it")

	require.Equal(t, 200, call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{"require":true}`, js).Code)
	assert.Equal(t, true, status()["require_trusted_device"])
	assert.Equal(t, 403, call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{"require":false}`, agent).Code, "an agent cannot turn it off")
	assert.Equal(t, 403, call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{"require":false}`, hub).Code, "nor the Hub")
	assert.Equal(t, true, status()["require_trusted_device"])
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{"require":false}`, js).Code)
	assert.Equal(t, false, status()["require_trusted_device"])
}

func TestRequireTrustedDeviceEnvTurnsItOnAndTheDashboardCannotTurnItOff(t *testing.T) {
	t.Setenv("CORAL_REQUIRE_TRUSTED_DEVICE", "1")
	r := newE2ERemote(t, "require-device-env", nil)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	seedDevice(t, store.NewSessionStore(r.db), 12, "interact")
	rec := call(h, "GET", "/api/cloud/status", "", nil)
	assert.Contains(t, rec.Body.String(), `"require_trusted_device":true`)
	assert.Contains(t, rec.Body.String(), `"require_trusted_device_env":true`)
	off := call(h, "PUT", "/api/cloud/hub-require-trusted-device", `{"require":false}`, js)
	assert.Equal(t, 409, off.Code)
	assert.Contains(t, off.Body.String(), "set_by_environment")
	assert.Equal(t, 200, call(h, "GET", "/api/sessions/live", "", nil).Code, "local use is untouched")
}
