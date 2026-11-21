package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20368 (multi-Hub slice 3): a second link is its own record. The one enrollment's save, delete and mirror touch only the link they made, and each link keeps its own cap and sealed token.
func TestASecondLinkIsItsOwnAndTheEnrollmentsChangesNeverTouchIt(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub-a.example.com", "srv_a", "Laptop", "tok-a"))

	// The gate is shut by default: the store refuses before anything is written.
	_, err := cs.AddLink(ctx, "https://hub-b.example.com", "srv_b", "Laptop B", "tok-b", "view")
	require.ErrorIs(t, err, ErrSecondLinkNotYet)
	ls, _ := cs.ListLinks(ctx)
	require.Len(t, ls, 1)

	AllowSecondLinkForTest(t)
	b, err := cs.AddLink(ctx, "https://Hub-B.example.com/", "srv_b", "Laptop B", "tok-b", "interact")
	require.NoError(t, err)
	assert.Equal(t, "https://hub-b.example.com", b.HubOrigin)
	_, err = cs.AddLink(ctx, "https://hub-b.example.com", "srv_b2", "again", "tok-b2", "view")
	require.ErrorIs(t, err, ErrLinkExists, "one link per Hub")
	_, err = cs.AddLink(ctx, "https://hub-c.example.com", "srv_c", "C", "tok-c", "root")
	require.Error(t, err, "a cap is a tier name")

	ls, err = cs.ListLinks(ctx)
	require.NoError(t, err)
	require.Len(t, ls, 2)
	a := ls[0]
	assert.Equal(t, "https://hub-a.example.com", a.HubOrigin)
	assert.Equal(t, "view", a.MaxMode)
	assert.Equal(t, "interact", ls[1].MaxMode, "with two links each keeps its own cap")
	tok, err := cs.LinkToken(ctx, b.LinkID)
	require.NoError(t, err)
	assert.Equal(t, "tok-b", tok)

	// A new enrollment replaces the enrollment's link only.
	require.NoError(t, cs.Save(ctx, "https://hub-a.example.com", "srv_a2", "Laptop", "tok-a2"))
	ls, _ = cs.ListLinks(ctx)
	require.Len(t, ls, 2)
	got, err := cs.LinkByOrigin(ctx, "https://hub-b.example.com")
	require.NoError(t, err)
	assert.Equal(t, b.LinkID, got.LinkID)
	tok, _ = cs.LinkToken(ctx, b.LinkID)
	assert.Equal(t, "tok-b", tok)

	// The mirror with the enrollment gone, and Delete, leave the second link.
	require.NoError(t, cs.Delete(ctx))
	require.NoError(t, cs.MirrorLegacyLink(ctx))
	ls, _ = cs.ListLinks(ctx)
	require.Len(t, ls, 1)
	assert.Equal(t, b.LinkID, ls[0].LinkID)
	assert.Equal(t, "interact", ls[0].MaxMode, "alone again, the cap shown is the live setting (one source of truth)")
}

// Removing one link finishes only that link; the other keeps its row, token and cap.
func TestFinishingOneLinksRemovalLeavesTheOther(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub-a.example.com", "srv_a", "Laptop", "tok-a"))
	AllowSecondLinkForTest(t)
	b, err := cs.AddLink(ctx, "https://hub-b.example.com", "srv_b", "Laptop B", "tok-b", "launch")
	require.NoError(t, err)
	a, err := cs.LinkByOrigin(ctx, "https://hub-a.example.com")
	require.NoError(t, err)

	require.NoError(t, cs.BeginRemoveLink(ctx, b.LinkID))
	require.NoError(t, cs.FinishRemoveLink(ctx, b.LinkID, LinkEventRemoved))
	ls, _ := cs.ListLinks(ctx)
	require.Len(t, ls, 1)
	assert.Equal(t, a.LinkID, ls[0].LinkID)
	tok, _ := cs.LinkToken(ctx, a.LinkID)
	assert.Equal(t, "tok-a", tok)
	conn, err := cs.Get(ctx)
	require.NoError(t, err, "the enrollment of A is untouched")
	assert.Equal(t, "srv_a", conn.ServerID)
}

// A link the Hub refused is marked revoked and keeps nothing else changed.
func TestARefusedLinkIsMarkedRevokedAndTheOtherIsUntouched(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub-a.example.com", "srv_a", "Laptop", "tok-a"))
	AllowSecondLinkForTest(t)
	b, err := cs.AddLink(ctx, "https://hub-b.example.com", "srv_b", "Laptop B", "tok-b", "view")
	require.NoError(t, err)
	require.NoError(t, cs.MarkLinkRevoked(ctx, b.LinkID, "revoked by the hub"))
	got, _ := cs.LinkByOrigin(ctx, "https://hub-b.example.com")
	assert.Equal(t, LinkStateRevoked, got.State)
	a, _ := cs.LinkByOrigin(ctx, "https://hub-a.example.com")
	assert.Equal(t, LinkStateActive, a.State)
	assert.False(t, cs.LinkExists(ctx, b.LinkID))
}
