package store

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21221: the Hub's poll learns the level the person gave once they have allowed, and not before; only the poll secret opens it, and it is never the code.
func TestLinkRequestCapGivenIsSaidOnlyAfterAllowAndToTheSecret(t *testing.T) {
	cs, ctx, now := reqRig(t)
	keyID, _, err := cs.CreateLinkKey(ctx, "Hub C", now)
	require.NoError(t, err)
	id, secret, err := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "interact", keyID, now)
	require.NoError(t, err)
	assert.Equal(t, "", cs.LinkRequestCapGiven(ctx, id, secret, now), "before Allow there is no level")
	code, _, err := cs.AllowLinkRequest(ctx, id, "view", now)
	require.NoError(t, err)
	assert.Equal(t, "view", cs.LinkRequestCapGiven(ctx, id, secret, now), "the level given, not the one asked")
	assert.NotContains(t, cs.LinkRequestCapGiven(ctx, id, secret, now), code)
	assert.Equal(t, "", cs.LinkRequestCapGiven(ctx, id, "0123456789abcdef0123456789abcdef", now), "a wrong secret learns nothing")
	assert.Equal(t, "", cs.LinkRequestCapGiven(ctx, "req-nope", secret, now), "an unknown request learns nothing")
}
