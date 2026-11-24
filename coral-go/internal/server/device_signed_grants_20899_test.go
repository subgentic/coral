package server

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #20899: removing an owner device offers to end the access it signed, and ends it when asked.
func TestRemovingAnOwnerDeviceCanAlsoEndTheAccessItSigned(t *testing.T) {
	g := newGrantRig(t)
	h := g.d.r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	require.Equal(t, 200, g.post(g.owner, g.ownK, relayOwner, teamGrants, g.grantBody(g.owner, g.ownK, viewGrant(testLinkID), nil), nil).Code)

	rec := call(h, "GET", "/api/cloud/devices/"+g.ownK+"/signed-grants", "", js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var out map[string]int
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, 1, out["live"])

	// Removing without the flag leaves the access.
	other, otherK := g.ownerKeyOfMode("view")
	_ = other
	require.Equal(t, 200, call(h, "DELETE", "/api/cloud/devices/"+otherK, "", js).Code)
	assert.Len(t, g.rows(), 1)

	// Removing with it ends what the device signed, and says who ended it.
	require.Equal(t, 200, call(h, "DELETE", "/api/cloud/devices/"+g.ownK+"?revoke_grants=1", "", js).Code)
	assert.Empty(t, g.rows())
	gr, err := g.d.r.srv.boardStore.MemberGrantNotices(t.Context(), timeLongAgo(), timeNow(), false, 10)
	require.NoError(t, err)
	require.Len(t, gr, 1)
	assert.Equal(t, board.MemberRevokedDeviceGone, gr[0].RevokedBy)
}
