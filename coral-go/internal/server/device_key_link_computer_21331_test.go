package server

import (
	"encoding/json"
	"log/slog"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #21331 (coral-hub, the Hub signer beta gate): GET /api/device-keys/link also says which computer this is: "computer", the 43-character base64url id every signed message names (devicekey.ComputerKey.Computer),
// so the browser page knows which pinned computer it is signing for. Same guards as the link (owner only, tunneled only); left out, never empty, when this computer has no key yet.
func TestTheLinkReadAlsoNamesThisComputersOwnKey(t *testing.T) {
	r := newE2ERemote(t, "device-key-link-computer", nil)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	ctx := t.Context()
	cs := store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.cfg.CoralDir()))
	require.NoError(t, cs.Save(ctx, "https://hub.example.invalid", "srv_1", "L", "coralhub_srv_abcd1234_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"))
	pinned, err := cs.PinOwnerUser(ctx, "srv_1", "hub-user-1234abcd")
	require.NoError(t, err)
	require.True(t, pinned)
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"launch"}`, js).Code)
	lk, err := cs.LinkByOrigin(ctx, "https://hub.example.invalid")
	require.NoError(t, err)
	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd", tunnel.LinkHeader: lk.LinkID}
	read := func(hdr map[string]string) (int, map[string]string, string) {
		rec := call(h, "GET", "/api/device-keys/link", "", hdr)
		var out map[string]string
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out, rec.Body.String()
	}

	// no key yet: the link alone, and no "computer" at all (never an empty string)
	r.srv.SetCloud(cloud.New(cloud.Options{HubURL: "https://hub.example.invalid", Store: cs, Logger: slog.New(slog.DiscardHandler)}))
	code, out, raw := read(owner)
	require.Equal(t, 200, code, raw)
	assert.Equal(t, map[string]string{"link": lk.LinkID}, out)
	assert.NotContains(t, raw, "computer")

	// with a key: the same id the pairing page pins and every signed message names
	key, err := devicekey.LoadOrCreateComputerKey(t.TempDir())
	require.NoError(t, err)
	r.srv.SetCloud(cloud.New(cloud.Options{HubURL: "https://hub.example.invalid", Store: cs, ComputerKey: key, Logger: slog.New(slog.DiscardHandler)}))
	code, out, raw = read(owner)
	require.Equal(t, 200, code, raw)
	assert.Equal(t, map[string]string{"link": lk.LinkID, "computer": key.Computer()}, out)
	assert.Regexp(t, regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`), out["computer"])
	assert.NotContains(t, raw, string(key.Pub()), "only the id, never the key")

	// not the owner, not through the Hub: refused, and the id is in no refusal
	for who, hdr := range map[string]map[string]string{
		"a grantee":       {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "hub-user-9999ffff", tunnel.LinkHeader: lk.LinkID},
		"no Hub account":  {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: lk.LinkID},
		"a forged stamp":  {tunnel.ViaHeader: "1", tunnel.LinkHeader: lk.LinkID},
		"a local request": nil,
	} {
		code, _, raw := read(hdr)
		assert.Contains(t, []int{401, 403, 404}, code, who)
		assert.NotContains(t, raw, key.Computer(), who)
	}
}
