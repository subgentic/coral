package store

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20201 (multi-Hub slice 1): a link's key is its canonical origin, so two spellings of one Hub are one key and an address that names no Hub is no key.
func TestCanonicalHubOriginIsOneKeyPerHub(t *testing.T) {
	for in, want := range map[string]string{
		"https://hub.example.com":      "https://hub.example.com",
		"https://Hub.Example.COM/":     "https://hub.example.com",
		"https://hub.example.com./":    "https://hub.example.com",
		"https://hub.example.com:443":  "https://hub.example.com",
		"https://hub.example.com:8443": "https://hub.example.com:8443",
		"https://bücher.example":       "https://xn--bcher-kva.example",
		"http://127.0.0.1:8420/":       "http://127.0.0.1:8420",
		"http://localhost":             "http://localhost",
		"http://[::1]:9":               "http://[::1]:9",
	} {
		got, err := CanonicalHubOrigin(in)
		require.NoError(t, err, in)
		assert.Equal(t, want, got, in)
	}
	for _, bad := range []string{"https://hub.example.com/path", "https://hub.example.com/a/", "https://hub.example.com?x=1", "https://hub.example.com/?", "https://hub.example.com#f", "https://hub.example.com/#f", "", "hub.example.com", "http://hub.example.com", "ftp://hub.example.com", "https://user:pw@hub.example.com", "https://", "https://exa mple.com", "https://hub.example.com:99999x"} {
		_, err := CanonicalHubOrigin(bad)
		assert.Error(t, err, "%q is not a link key", bad)
	}
}

var linkIDForm = regexp.MustCompile(`^lnk-[0-9a-f]{8}$`)

// The enrollment is mirrored as one link whose token is sealed under the link's own AAD (never the old one), and a new enrollment is a new link.
func TestSavingAnEnrollmentMakesOneLinkWithItsOwnSealedToken(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()

	links, err := cs.ListLinks(ctx)
	require.NoError(t, err)
	assert.Empty(t, links, "nothing enrolled")

	require.NoError(t, cs.Save(ctx, "https://Hub.Example.com/", "srv_1", "Laptop", "tok-one"))
	links, err = cs.ListLinks(ctx)
	require.NoError(t, err)
	require.Len(t, links, 1)
	l := links[0]
	assert.Regexp(t, linkIDForm, l.LinkID)
	assert.Equal(t, "https://hub.example.com", l.HubOrigin)
	assert.Equal(t, "srv_1", l.ServerID)
	assert.Equal(t, "Laptop", l.Label)
	assert.Equal(t, LinkStateActive, l.State)
	assert.Equal(t, "view", l.MaxMode, "no cap saved: the least")
	assert.Equal(t, "all", l.Scope)

	tok, err := cs.LinkToken(ctx, l.LinkID)
	require.NoError(t, err)
	assert.Equal(t, "tok-one", tok)
	var env string
	require.NoError(t, db.GetContext(ctx, &env, "SELECT token FROM cloud_link WHERE link_id = ?", l.LinkID))
	assert.False(t, strings.Contains(env, "tok-one"), "never plaintext")
	box, err := rs.getBox(ctx, false, false)
	require.NoError(t, err)
	_, err = box.Open(cloudAAD("srv_1"), env)
	assert.Error(t, err, "bound to the link, not to the old enrollment's AAD")

	// A link found by any spelling of its address.
	got, err := cs.LinkByOrigin(ctx, "https://HUB.example.com:443/")
	require.NoError(t, err)
	assert.Equal(t, l.LinkID, got.LinkID)
	_, err = cs.LinkByOrigin(ctx, "https://other.example.com")
	assert.ErrorIs(t, err, ErrNoCloudLink)
	_, err = CanonicalHubOrigin("https://hub.example.com/some/path")
	assert.Error(t, err, "a new link's address with a path is refused (the lookup of the one legacy enrollment is the only place that cuts it)")

	// The same Hub enrolled again is a new link with the new token.
	require.NoError(t, cs.Save(ctx, "https://hub.example.com", "srv_1", "Laptop", "tok-two"))
	links, _ = cs.ListLinks(ctx)
	require.Len(t, links, 1)
	assert.NotEqual(t, l.LinkID, links[0].LinkID)
	tok, _ = cs.LinkToken(ctx, links[0].LinkID)
	assert.Equal(t, "tok-two", tok)
	_, err = cs.LinkToken(ctx, l.LinkID)
	assert.ErrorIs(t, err, ErrNoCloudLink)

	require.NoError(t, cs.Delete(ctx))
	links, _ = cs.ListLinks(ctx)
	assert.Empty(t, links, "the link goes with the enrollment")
}

// The link follows the enrollment's state and its owner pin.
func TestTheLinkFollowsTheEnrollmentsStateAndOwnerPin(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub.example.com", "srv_1", "Laptop", "tok"))

	require.NoError(t, cs.SetState(ctx, CloudStateRevoked, "the hub revoked this server"))
	ok, err := cs.PinOwner(ctx, "srv_1", "acct-1")
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = cs.PinOwnerUser(ctx, "srv_1", "hub-user-1a2b3c4d")
	require.NoError(t, err)
	require.True(t, ok)
	ok, err = cs.AdoptOwnerUser(ctx, "srv_1", "hub-user-ffffffff", "2026-11-21T00:00:00Z")
	require.NoError(t, err)
	assert.False(t, ok, "a label is never replaced")

	links, _ := cs.ListLinks(ctx)
	require.Len(t, links, 1)
	assert.Equal(t, LinkStateRevoked, links[0].State)
	require.NotNil(t, links[0].LastError)
	assert.Contains(t, *links[0].LastError, "revoked")
	assert.Equal(t, "acct-1", links[0].OwnerAccount)
	assert.Equal(t, "hub-user-1a2b3c4d", links[0].OwnerUser)

	require.NoError(t, cs.BlockOwner(ctx, "srv_1"))
	links, _ = cs.ListLinks(ctx)
	assert.Equal(t, OwnerBlocked, links[0].OwnerAccount)
}

// The upgrade: a data folder written by the current release has a cloud_connection row and no cloud_link table. The link is made from the row, once; the old row is not touched.
func TestAFolderWrittenByTheCurrentReleaseGetsItsLinkOnce(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub.example.com", "srv_1", "Laptop", "tok-keep"))
	_, err := cs.PinOwner(ctx, "srv_1", "acct-9")
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, "INSERT INTO user_settings (key, value) VALUES ('cloud_max_mode', 'Interact')")
	require.NoError(t, err)
	// As the previous release left it: the same enrollment, and no link tables.
	var before string
	require.NoError(t, db.GetContext(ctx, &before, "SELECT token FROM cloud_connection WHERE id = 1"))
	_, err = db.ExecContext(ctx, "DROP TABLE cloud_link")
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, "DROP TABLE cloud_link_user")
	require.NoError(t, err)
	// The first start of the new release creates the tables (the schema is IF NOT EXISTS) and the link.
	_, err = db.ExecContext(ctx, schemaSQL)
	require.NoError(t, err)
	require.NoError(t, cs.MirrorLegacyLink(ctx))

	links, err := cs.ListLinks(ctx)
	require.NoError(t, err)
	require.Len(t, links, 1)
	assert.Equal(t, "interact", links[0].MaxMode, "today's saved cap, normalised")
	assert.Equal(t, "acct-9", links[0].OwnerAccount, "the owner pin comes along")
	tok, err := cs.LinkToken(ctx, links[0].LinkID)
	require.NoError(t, err)
	assert.Equal(t, "tok-keep", tok)
	var after string
	require.NoError(t, db.GetContext(ctx, &after, "SELECT token FROM cloud_connection WHERE id = 1"))
	assert.Equal(t, before, after, "the old row is kept as it was, for a downgrade")
	tokOld, err := cs.Token(ctx)
	require.NoError(t, err)
	assert.Equal(t, "tok-keep", tokOld, "the connector still reads the enrollment")

	// Run again: the same link, nothing new.
	require.NoError(t, cs.MirrorLegacyLink(ctx))
	again, _ := cs.ListLinks(ctx)
	require.Len(t, again, 1)
	assert.Equal(t, links[0].LinkID, again[0].LinkID)
	assert.Equal(t, links[0].CreatedAt, again[0].CreatedAt)
}

// A token that can't be read makes a paused link with no token that says to enrol again; the enrollment itself is not touched and nothing fails.
func TestATokenThatCannotBeReadMakesAPausedLink(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub.example.com", "srv_1", "Laptop", "tok"))
	_, err := db.ExecContext(ctx, "UPDATE cloud_connection SET token = 'v1:not-an-envelope'")
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, "DELETE FROM cloud_link")
	require.NoError(t, err)

	require.NoError(t, cs.MirrorLegacyLink(ctx))
	links, _ := cs.ListLinks(ctx)
	require.Len(t, links, 1)
	assert.Equal(t, LinkStatePaused, links[0].State)
	require.NotNil(t, links[0].LastError)
	assert.Contains(t, *links[0].LastError, "re-enrol")
	_, err = cs.LinkToken(ctx, links[0].LinkID)
	assert.ErrorIs(t, err, ErrKeyUnreadable)
	conn, err := cs.Get(ctx)
	require.NoError(t, err)
	assert.Equal(t, "srv_1", conn.ServerID, "the enrollment is as it was")

	// A refresh keeps it paused even though the enrollment says active.
	require.NoError(t, cs.MirrorLegacyLink(ctx))
	links, _ = cs.ListLinks(ctx)
	assert.Equal(t, LinkStatePaused, links[0].State)
}

// An enrollment address that is not a usable link key is an error to report, not a link, and the enrollment stays.
func TestAnEnrollmentWithNoUsableOriginMakesNoLink(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "http://hub.example.com", "srv_1", "Laptop", "tok")) // plain http to a non-loopback host
	links, _ := cs.ListLinks(ctx)
	assert.Empty(t, links)
	assert.Error(t, cs.MirrorLegacyLink(ctx))
	_, err := cs.Get(ctx)
	assert.NoError(t, err, "Coral keeps the enrollment")
}

// Security's SHOULD on #20201: forgetting the enrollment and its link is one transaction, so a failure leaves both, never a link and token after a disconnect.
func TestDeleteIsOneTransaction(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub.example.com", "srv_1", "Laptop", "tok"))
	_, err := db.ExecContext(ctx, "CREATE TRIGGER refuse_link_delete BEFORE DELETE ON cloud_link BEGIN SELECT RAISE(ABORT, 'refused'); END")
	require.NoError(t, err)

	require.Error(t, cs.Delete(ctx))
	_, err = cs.Get(ctx)
	assert.NoError(t, err, "the enrollment is still there: the delete rolled back")
	links, _ := cs.ListLinks(ctx)
	assert.Len(t, links, 1)

	_, err = db.ExecContext(ctx, "DROP TRIGGER refuse_link_delete")
	require.NoError(t, err)
	require.NoError(t, cs.Delete(ctx))
	_, err = cs.Get(ctx)
	assert.ErrorIs(t, err, ErrNoCloudConnection)
	links, _ = cs.ListLinks(ctx)
	assert.Empty(t, links)
}

// Security's point 9 and the upgrade rule (#20312): an enrollment whose Hub address has a path, as the previous release saved it, still mirrors, is found for the dial and keeps the token;
// the dial address is not changed. A NEW link's origin with a path is still refused, and nothing but the legacy mirror and lookup accepts a path.
func TestAnEnrollmentWithAPathStillMirrorsAndDialsButANewLinkRefusesAPath(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	const enrolled = "https://hub.example.com/app/"
	require.NoError(t, cs.Save(ctx, enrolled, "srv_1", "Laptop", "tok-keep"))
	// As v2.1.2 left it: the enrollment and no link tables.
	_, err := db.ExecContext(ctx, "DROP TABLE cloud_link")
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, "DROP TABLE cloud_link_user")
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, schemaSQL)
	require.NoError(t, err)

	require.NoError(t, cs.MirrorLegacyLink(ctx))
	links, err := cs.ListLinks(ctx)
	require.NoError(t, err)
	require.Len(t, links, 1)
	assert.Equal(t, "https://hub.example.com", links[0].HubOrigin, "the origin is the key")
	assert.Equal(t, LinkStateActive, links[0].State)
	tok, err := cs.LinkToken(ctx, links[0].LinkID)
	require.NoError(t, err)
	assert.Equal(t, "tok-keep", tok)
	found, err := cs.LinkByOrigin(ctx, enrolled)
	require.NoError(t, err)
	assert.Equal(t, links[0].LinkID, found.LinkID, "the enrolled address finds its link")
	assert.True(t, HubAddressHasPath(enrolled))
	assert.False(t, HubAddressHasPath("https://hub.example.com"))
	var hubURL string
	require.NoError(t, db.GetContext(ctx, &hubURL, "SELECT hub_url FROM cloud_connection WHERE id = 1"))
	assert.Equal(t, "https://hub.example.com/app", hubURL, "the enrolled address is kept exactly as Save stored it, not cut to the site")

	// A changed Hub address is not this enrollment's link: no match on another host.
	_, err = cs.LinkByOrigin(ctx, "https://other.example.com/app/")
	assert.ErrorIs(t, err, ErrNoCloudLink)

	// A new link: a path is refused, whatever else is true.
	for _, raw := range []string{enrolled, "https://hub.example.com/app", "https://hub.example.com?x=1", "https://hub.example.com/#f"} {
		_, err := CanonicalHubOrigin(raw)
		assert.Error(t, err, raw)
	}
	// Not reachable by anything but the enrollment: user information and a non-https host are refused even in the legacy path.
	_, _, err = legacyHubOrigin("https://u:p@hub.example.com/app")
	assert.Error(t, err)
	_, _, err = legacyHubOrigin("http://hub.example.com/app")
	assert.Error(t, err)
}

// Security's point 8: only an active link passes; a paused, revoked or removing link and an unknown id are refused.
func TestOnlyAnActiveLinkExists(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub.example.com", "srv_1", "Laptop", "tok"))
	links, _ := cs.ListLinks(ctx)
	require.Len(t, links, 1)
	id := links[0].LinkID
	assert.True(t, cs.LinkExists(ctx, id))
	assert.False(t, cs.LinkExists(ctx, "lnk-00000000"))
	for _, st := range []string{LinkStatePaused, LinkStateRevoked, LinkStateRemoving} {
		_, err := db.ExecContext(ctx, "UPDATE cloud_link SET state = ? WHERE link_id = ?", st, id)
		require.NoError(t, err)
		assert.False(t, cs.LinkExists(ctx, id), st)
	}
	_, err := db.ExecContext(ctx, "UPDATE cloud_link SET state = ? WHERE link_id = ?", LinkStateActive, id)
	require.NoError(t, err)
	assert.True(t, cs.LinkExists(ctx, id))
}
