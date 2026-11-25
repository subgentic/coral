package store

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21220, design (B): a self-hosted Hub's request, made with its request key, finishes as a link that key answers to: no token, no tunnel. The consume and the link are one transaction; the answer is the link.
func TestAKeysRequestFinishesAsALinkThatKeyAnswersTo(t *testing.T) {
	cs, ctx, now := reqRig(t)
	keyID, _, err := cs.CreateLinkKey(ctx, "Hub C", now)
	require.NoError(t, err)
	id, secret, err := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "interact", keyID, now)
	require.NoError(t, err)
	code, _, err := cs.AllowLinkRequest(ctx, id, "view", now)
	require.NoError(t, err)

	_, err = cs.FinishLinkRequestAsKeyLink(ctx, id, secret, code, "", now)
	assert.ErrorIs(t, err, ErrLinkRequestNone, "only the key that made it")
	l, err := cs.FinishLinkRequestAsKeyLink(ctx, id, secret, code, keyID, now)
	require.NoError(t, err)
	assert.Equal(t, LinkSourceKey, l.Source)
	assert.Equal(t, keyID, l.KeyID)
	assert.Equal(t, "view", l.MaxMode, "the cap the person gave, not the one asked")
	assert.Equal(t, "https://hub-c.example.com", l.HubOrigin)
	got, err := cs.KeyLink(ctx, keyID)
	require.NoError(t, err)
	assert.Equal(t, l.LinkID, got.LinkID)

	_, err = cs.FinishLinkRequestAsKeyLink(ctx, id, secret, code, keyID, now)
	assert.ErrorIs(t, err, ErrLinkRequestNone, "a replay writes nothing")
	links, err := cs.ListLinks(ctx)
	require.NoError(t, err)
	n := 0
	for _, x := range links {
		if x.Source == LinkSourceKey {
			n++
		}
	}
	assert.Equal(t, 1, n)

	// revoking the key: the link shows as revoked, never as a working link, and the key reaches no link
	require.NoError(t, cs.RevokeLinkKey(ctx, keyID, now))
	_, err = cs.KeyLink(ctx, keyID)
	assert.ErrorIs(t, err, ErrNoCloudLink)
	r, err := cs.LinkByOrigin(ctx, "https://hub-c.example.com")
	require.NoError(t, err)
	assert.Equal(t, LinkStateRevoked, r.State)
}

// A finish whose link cannot be written (that Hub is already linked) leaves the request as it was: nothing is consumed and nothing written.
func TestAKeyLinkThatCannotBeWrittenConsumesNothing(t *testing.T) {
	cs, ctx, now := reqRig(t)
	keyID, _, err := cs.CreateLinkKey(ctx, "Hub C", now)
	require.NoError(t, err)
	id, secret, err := cs.CreateLinkRequest(ctx, "https://hub-c.example.com", "view", keyID, now)
	require.NoError(t, err)
	code, _, err := cs.AllowLinkRequest(ctx, id, "view", now)
	require.NoError(t, err)
	_, err = cs.db.ExecContext(ctx, `INSERT INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, created_at, source) VALUES ('lnk-x', 'https://hub-c.example.com', 's', 'l', 't', 'active', 'view', ?, 'added')`, now.Format(time.RFC3339))
	require.NoError(t, err)
	_, err = cs.FinishLinkRequestAsKeyLink(ctx, id, secret, code, keyID, now)
	assert.ErrorIs(t, err, ErrLinkExists)
	st, err := cs.LinkRequestStatus(ctx, id, secret, now)
	require.NoError(t, err)
	assert.Equal(t, "allowed", st, "the request was not consumed")
	_, err = cs.KeyLink(ctx, keyID)
	assert.ErrorIs(t, err, ErrNoCloudLink)
}

// #21261: the hub id a self-hosted Hub says it is goes with its request and onto the key link that comes of it; only a request key's request keeps one, and only a valid hub id is taken.
func TestAKeyLinkKeepsTheHubIDItsHubGave(t *testing.T) {
	cs, ctx, now := reqRig(t)
	keyID, _, err := cs.CreateLinkKey(ctx, "Hub C", now)
	require.NoError(t, err)
	_, _, err = cs.CreateLinkRequestFor(ctx, "https://hub-c.example.com", "interact", keyID, "Not A Hub!", now)
	assert.Error(t, err, "not a hub id")
	_, _, err = cs.CreateLinkRequestFor(ctx, "https://hub-c.example.com", "interact", "", "hub-aaaaaaaa", now)
	assert.Error(t, err, "a request no key made keeps no hub id")
	id, secret, err := cs.CreateLinkRequestFor(ctx, "https://hub-c.example.com", "interact", keyID, "hub-aaaaaaaa", now)
	require.NoError(t, err)
	code, _, err := cs.AllowLinkRequest(ctx, id, "view", now)
	require.NoError(t, err)
	l, err := cs.FinishLinkRequestAsKeyLink(ctx, id, secret, code, keyID, now)
	require.NoError(t, err)
	assert.Equal(t, "hub-aaaaaaaa", cs.KeyLinkHubID(ctx, l.LinkID))
	assert.Equal(t, "", cs.KeyLinkHubID(ctx, "lnk-00000000"), "no such link")

	// a request that said none, and a link that is not a key link, have none
	keyID2, _, err := cs.CreateLinkKey(ctx, "Hub D", now)
	require.NoError(t, err)
	id2, secret2, err := cs.CreateLinkRequest(ctx, "https://hub-d.example.com", "interact", keyID2, now)
	require.NoError(t, err)
	code2, _, err := cs.AllowLinkRequest(ctx, id2, "view", now)
	require.NoError(t, err)
	l2, err := cs.FinishLinkRequestAsKeyLink(ctx, id2, secret2, code2, keyID2, now)
	require.NoError(t, err)
	assert.Equal(t, "", cs.KeyLinkHubID(ctx, l2.LinkID))
}
