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
