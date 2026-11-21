package routes

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
)

// #20312: the record of an Operator action through Coral Hub carries the link and the Hub person the connector stamped, taken from the request's context and from nothing the request says;
// an action with no stamp (a sign-in event on this computer) records none.
func TestAnOperatorActionRecordsTheLinkPairFromTheRequestContext(t *testing.T) {
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer bs.Close()
	ctx := context.Background()

	recordHubOperatorAction(cloud.WithVia(ctx, cloud.Via{LinkID: "lnk-0123abcd", HubUser: "hub-user-1234abcd"}), bs, "hub-user-1234abcd", "POST", "/api/board/p/messages", "p", 200)
	recordHubOwnerAction(cloud.WithVia(ctx, cloud.Via{LinkID: "lnk-0123abcd"}), bs, callerIdentity{pseudo: "hub-user-1234abcd"}, "PUT", "/api/board/p/settings", "p", 200)
	recordHubOperatorAction(ctx, bs, "this computer", "EVENT", "sign-in", "", 200)

	recent, err := bs.RecentHubOperatorActions(ctx, 3)
	require.NoError(t, err)
	require.Len(t, recent, 3)
	assert.Empty(t, recent[0].ViaLink, "no stamp, no pair")
	assert.Equal(t, "lnk-0123abcd", recent[1].ViaLink)
	assert.Empty(t, recent[1].ViaHubUser, "the stream named no person")
	assert.Equal(t, "lnk-0123abcd", recent[2].ViaLink)
	assert.Equal(t, "hub-user-1234abcd", recent[2].ViaHubUser)
}
