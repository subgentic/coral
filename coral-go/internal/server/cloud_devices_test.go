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

func seedDevice(t *testing.T, ss *store.SessionStore, n byte, mode string) string {
	t.Helper()
	pk := make([]byte, 65)
	pk[0], pk[1] = 0x04, n
	sum := sha256.Sum256(pk)
	kid := base64.RawURLEncoding.EncodeToString(sum[:])
	_, err := ss.AddDeviceKey(context.Background(), store.DeviceKey{KID: kid, PK: pk, Label: "Laptop", Mode: mode, Origin: store.DeviceOriginPairing, Kind: store.DeviceKindDevice, Link: store.PairOwner, HubUser: store.PairOwner}, time.Now())
	require.NoError(t, err)
	return kid
}

// coral-hub condition (e): the person at this computer lowers the web default and any one device, and removes one; none of it is reachable through the tunnel at any mode, and the web mode cannot be written through the generic settings route either.
func TestDeviceListIsLocalOnlyAndTheOwnerCanLowerAndRemove(t *testing.T) {
	r := newE2ERemote(t, "device-list", nil)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	hub := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	ss := store.NewSessionStore(r.db)
	kid := seedDevice(t, ss, 1, "launch")

	routes := [][3]string{
		{"GET", "/api/cloud/devices", ""},
		{"PUT", "/api/cloud/device-web-mode", `{"mode":"view"}`},
		{"PUT", "/api/cloud/devices/" + kid + "/mode", `{"mode":"view"}`},
		{"DELETE", "/api/cloud/devices/" + kid, ""},
		{"POST", "/api/cloud/devices/clear-clock", `{}`},
	}
	for _, rt := range routes {
		assert.Equal(t, tunnel.TierNever, tunnel.Classify(rt[0], rt[1], ""), rt[0]+" "+rt[1])
		assert.Equal(t, 403, call(h, rt[0], rt[1], rt[2], hub).Code, "never through the hub: %s %s", rt[0], rt[1])
	}
	assert.Equal(t, store.DeviceWebModeDefault, ss.DeviceWebMode(context.Background()), "nothing the hub sent changed anything")
	active, _ := ss.ActiveDeviceKey(context.Background(), kid, time.Now())
	assert.Equal(t, "launch", active.Mode)

	// The generic PUT /api/settings refuses the key for every caller (TestPutSettingsRefusesHubTrustSettings holds it).

	rec := call(h, "GET", "/api/cloud/devices", "", js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var list struct {
		WebMode string                              `json:"web_mode"`
		Devices []struct{ KID, Label, Mode string } `json:"devices"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &list))
	assert.Equal(t, "launch", list.WebMode)
	require.Len(t, list.Devices, 1)

	require.Equal(t, 400, call(h, "PUT", "/api/cloud/device-web-mode", `{"mode":"root"}`, js).Code)
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/device-web-mode", `{"mode":"interact"}`, js).Code)
	assert.Equal(t, "interact", ss.DeviceWebMode(context.Background()))
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/devices/"+kid+"/mode", `{"mode":"view"}`, js).Code)
	active, _ = ss.ActiveDeviceKey(context.Background(), kid, time.Now())
	assert.Equal(t, "view", active.Mode)
	require.Equal(t, 404, call(h, "PUT", "/api/cloud/devices/nope/mode", `{"mode":"view"}`, js).Code)
	require.Equal(t, 200, call(h, "DELETE", "/api/cloud/devices/"+kid, "", js).Code)
	_, err := ss.ActiveDeviceKey(context.Background(), kid, time.Now())
	assert.Error(t, err, "removed")
	require.Equal(t, 404, call(h, "DELETE", "/api/cloud/devices/"+kid, "", js).Code)
}

// The clock notice: a mark in the future says what the clock was compared with and the one command that resets it; the reset is local and makes the mark now.
func TestDeviceListShowsTheClockNoticeAndTheOwnerResetsIt(t *testing.T) {
	r := newE2ERemote(t, "device-clock", nil)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	ss := store.NewSessionStore(r.db)
	require.NoError(t, ss.ClearClockMark(context.Background(), time.Now().Add(48*time.Hour)))
	rec := call(h, "GET", "/api/cloud/devices", "", js)
	require.Equal(t, 200, rec.Code)
	assert.Contains(t, rec.Body.String(), "coral cloud devices clear-clock")
	assert.Contains(t, rec.Body.String(), "This computer's clock is behind the last time it accepted a device message (")
	require.Equal(t, 200, call(h, "POST", "/api/cloud/devices/clear-clock", `{}`, js).Code)
	rec = call(h, "GET", "/api/cloud/devices", "", js)
	assert.NotContains(t, rec.Body.String(), "clock_notice")
}
