package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Every route that asks routes.artifactReadable (the reviewed list is TestEveryCallerOfArtifactReadableIsReviewed in internal/server/routes) through the real router and the real stamp (#14913, Security's #14912):
// the owner's own stream reads, and a grantee, a stamp with no Hub account, a forged stamp (with or without a session token) and an owner role for another account read nothing: 401 or 403, never the artifact.
func TestEveryArtifactReadRouteRefusesAForgedTunnelStamp(t *testing.T) {
	r := newE2ERemote(t, "artifact-read-stamp", nil)
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

	objects := filepath.Join(r.cfg.CoralDir(), "artifacts", "objects")
	require.NoError(t, os.MkdirAll(objects, 0o700))
	content := "an agent's note for the stamp census"
	sum := sha256.Sum256([]byte(content))
	id := hex.EncodeToString(sum[:])
	require.NoError(t, os.WriteFile(filepath.Join(objects, id), []byte(content), 0o600))
	meta, _ := json.Marshal(map[string]any{"name": "note.txt", "media_type": "text/plain", "size": len(content), "digest": "sha256:" + id})
	require.NoError(t, os.WriteFile(filepath.Join(objects, id+".json"), meta, 0o600))

	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"}
	refused := map[string]map[string]string{
		"a grantee": {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "hub-user-9999ffff"},
		"the real stamp and no Hub account at all": {tunnel.ViaHeader: cloud.ViaSecret()},
		"the owner role for another account":       {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-9999ffff"},
		"a forged stamp":                           {tunnel.ViaHeader: "1"},
		"a forged stamp claiming the owner":        {tunnel.ViaHeader: "1", tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"},
		"a forged stamp and a session token":       {tunnel.ViaHeader: "1", store.SessionTokenHeader: "not-a-real-token"},
		"a close stamp":                            {tunnel.ViaHeader: cloud.ViaSecret() + "x"},
	}
	for _, route := range []string{
		"/api/artifacts/" + id + "?v=2",
		"/api/artifacts/" + id + "/meta",
		"/api/artifacts/" + id + "/comments",
	} {
		rec := call(h, "GET", route, "", owner)
		assert.Equal(t, 200, rec.Code, "the owner's own stream reads %s: %s", route, rec.Body.String())
		for who, hdr := range refused {
			rec := call(h, "GET", route, "", hdr)
			assert.Contains(t, []int{401, 403, 404}, rec.Code, "%s must not read %s: %d %s", who, route, rec.Code, rec.Body.String())
			assert.NotContains(t, rec.Body.String(), content, "%s got the artifact's content from %s", who, route)
		}
	}
}
