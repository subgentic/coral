package store

import (
	"context"
	"regexp"
	"strings"
	"testing"
	"time"

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
	w := HubAddressWarning("https://hub.example.com/app?token=SECRET#frag")
	assert.Contains(t, w, "https://hub.example.com")
	assert.Contains(t, w, "extra parts")
	assert.NotContains(t, w, "SECRET", "the warning never shows the saved address")
	assert.NotContains(t, w, "/app")
	assert.Equal(t, "", HubAddressWarning("https://hub.example.com"))
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

// two links in one store for the isolation tests: the one the enrollment mirrors, and a second inserted as the later connector set will make it.
func twoLinks(t *testing.T) (*CloudStore, string, string) {
	t.Helper()
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub-a.example.com", "srv_a", "Laptop", "tok-a"))
	_, err := cs.PinOwner(ctx, "srv_a", "acct-a")
	require.NoError(t, err)
	links, err := cs.ListLinks(ctx)
	require.NoError(t, err)
	require.Len(t, links, 1)
	_, err = db.ExecContext(ctx, `INSERT INTO cloud_link (link_id, hub_origin, server_id, label, token, state, max_mode, scope, owner_account, owner_user, created_at, source)
		VALUES ('lnk-0000000b', 'https://hub-b.example.com', 'srv_b', 'Laptop B', 'v1:b-sealed', 'active', 'interact', 'all', 'acct-b', 'hub-user-0000000b', '2026-01-01T00:00:00Z', 'added')`)
	require.NoError(t, err)
	return cs, links[0].LinkID, "lnk-0000000b"
}

// #20346: a cap is one link's, is logged in the same step, and a bad mode or an unknown link changes nothing.
func TestSetLinkCapIsOneLinksAndLogged(t *testing.T) {
	cs, a, _ := twoLinks(t)
	ctx := context.Background()
	old, err := cs.SetLinkCap(ctx, a, "launch")
	require.NoError(t, err)
	assert.Equal(t, "view", old, "the cap it had")
	la, _ := cs.LinkByOrigin(ctx, "https://hub-a.example.com")
	lb, _ := cs.LinkByOrigin(ctx, "https://hub-b.example.com")
	assert.Equal(t, "launch", la.MaxMode)
	assert.Equal(t, "interact", lb.MaxMode, "the other link's cap is as it was")
	ev, err := cs.ListLinkEvents(ctx, "", 10)
	require.NoError(t, err)
	require.Len(t, ev, 1)
	assert.Equal(t, a, ev[0].LinkID)
	assert.Equal(t, LinkEventCap, ev[0].Action)
	assert.Equal(t, "view -> launch", ev[0].Detail)
	assert.Equal(t, "https://hub-a.example.com", ev[0].HubOrigin)

	_, err = cs.SetLinkCap(ctx, a, "root")
	assert.Error(t, err)
	_, err = cs.SetLinkCap(ctx, "lnk-ffffffff", "view")
	assert.ErrorIs(t, err, ErrNoCloudLink)
	la, _ = cs.LinkByOrigin(ctx, "https://hub-a.example.com")
	assert.Equal(t, "launch", la.MaxMode, "a refused change changes nothing")
	ev, _ = cs.ListLinkEvents(ctx, "", 10)
	assert.Len(t, ev, 1, "a refused change is not logged as done")
}

// #20346: with one link the setting the live check reads follows the cap.
func TestSetLinkCapOfTheOnlyLinkMovesTheSetting(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	require.NoError(t, cs.Save(ctx, "https://hub.example.com", "srv_1", "Laptop", "tok"))
	links, _ := cs.ListLinks(ctx)
	_, err := cs.SetLinkCap(ctx, links[0].LinkID, "interact")
	require.NoError(t, err)
	var v string
	require.NoError(t, db.GetContext(ctx, &v, "SELECT value FROM user_settings WHERE key = 'cloud_max_mode'"))
	assert.Equal(t, "interact", v)
}

// #20346: removing one link leaves the other's row, token, owner pin, state and log alone, and the log outlives the removed link.
func TestRemovingOneLinkNeverTouchesAnother(t *testing.T) {
	cs, a, b := twoLinks(t)
	ctx := context.Background()
	tokBefore, err := cs.LinkToken(ctx, a)
	require.NoError(t, err)
	var rowBefore CloudLink
	require.NoError(t, cs.db.GetContext(ctx, &rowBefore, "SELECT link_id, hub_origin, server_id, label, state, max_mode, scope, owner_account, owner_user, owner_adopted_at, created_at, last_seen, last_error FROM cloud_link WHERE link_id = ?", a))

	require.NoError(t, cs.BeginRemoveLink(ctx, b))
	var st string
	require.NoError(t, cs.db.GetContext(ctx, &st, "SELECT state FROM cloud_link WHERE link_id = ?", b))
	assert.Equal(t, LinkStateRemoving, st)
	assert.False(t, cs.LinkExists(ctx, b), "a removing link has no stream and no sign-in")
	assert.True(t, cs.LinkExists(ctx, a))
	require.NoError(t, cs.BeginRemoveLink(ctx, b), "removal under way is idempotent")
	assert.ErrorIs(t, cs.FinishRemoveLink(ctx, a, LinkEventRemoved), ErrBadLinkState, "only a link in removing can be finished")

	require.NoError(t, cs.FinishRemoveLink(ctx, b, LinkEventRemoved))
	links, _ := cs.ListLinks(ctx)
	require.Len(t, links, 1)
	var rowAfter CloudLink
	require.NoError(t, cs.db.GetContext(ctx, &rowAfter, "SELECT link_id, hub_origin, server_id, label, state, max_mode, scope, owner_account, owner_user, owner_adopted_at, created_at, last_seen, last_error FROM cloud_link WHERE link_id = ?", a))
	assert.Equal(t, rowBefore, rowAfter, "the other link's row is as it was")
	tokAfter, err := cs.LinkToken(ctx, a)
	require.NoError(t, err)
	assert.Equal(t, tokBefore, tokAfter, "and its token still opens")
	conn, err := cs.Get(ctx)
	require.NoError(t, err)
	assert.Equal(t, "srv_a", conn.ServerID, "the enrollment of the other link stays")
	var n int
	require.NoError(t, cs.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM cloud_link WHERE link_id = ?", b))
	assert.Zero(t, n)
	evB, _ := cs.ListLinkEvents(ctx, b, 10)
	require.Len(t, evB, 2, "the log of a removed link stays: begin and removed")
	assert.Equal(t, LinkEventRemoved, evB[0].Action)
	assert.Equal(t, LinkEventRemoveBegin, evB[1].Action)
	evA, _ := cs.ListLinkEvents(ctx, a, 10)
	assert.Empty(t, evA, "nothing was logged against the other link")
}

// #20346: removing the link the enrollment mirrors ends the enrollment and its token in the same step, and the mirror does not make it again; the log never holds a token.
func TestRemovingTheMirroredLinkEndsTheEnrollment(t *testing.T) {
	cs, a, _ := twoLinks(t)
	ctx := context.Background()
	require.NoError(t, cs.BeginRemoveLink(ctx, a))
	require.NoError(t, cs.MirrorLegacyLink(ctx), "the mirror runs on every start")
	var st string
	require.NoError(t, cs.db.GetContext(ctx, &st, "SELECT state FROM cloud_link WHERE link_id = ?", a))
	assert.Equal(t, LinkStateRemoving, st, "a removing link stays removing through the mirror")
	require.NoError(t, cs.FinishRemoveLink(ctx, a, LinkEventDropped))
	var n int
	require.NoError(t, cs.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM cloud_connection"))
	assert.Zero(t, n, "no removed token stays in the old table")
	l, err := cs.LinkByOrigin(ctx, "https://hub-a.example.com")
	assert.Nil(t, l)
	assert.ErrorIs(t, err, ErrNoCloudLink)
	var logged string
	require.NoError(t, cs.db.GetContext(ctx, &logged, "SELECT COALESCE(group_concat(link_id || hub_origin || action || detail), '') FROM cloud_link_event"))
	assert.NotContains(t, logged, "tok-a")
	assert.NotContains(t, logged, "sealed")
	assert.Contains(t, logged, LinkEventDropped)
}

// #20346, Security's condition 3b: a second link is refused. SecondLinkOpen is the one switch; the server's census test fails if it is on while a Hub write is pending.
func TestASecondLinkIsRefusedWhileTheSwitchIsOff(t *testing.T) {
	rs, db, _, _ := newRemoteStore(t)
	cs := NewCloudStore(db, rs)
	ctx := context.Background()
	assert.NoError(t, cs.CheckCanAddLink(ctx), "the first link is fine")
	require.NoError(t, cs.Save(ctx, "https://hub.example.com", "srv_1", "Laptop", "tok"))
	if SecondLinkOpen {
		assert.NoError(t, cs.CheckCanAddLink(ctx), "the switch is on: a second link is allowed")
	} else {
		assert.ErrorIs(t, cs.CheckCanAddLink(ctx), ErrSecondLinkNotYet)
	}
}

// #20346, Security 4: a removal the Hub has not confirmed is listed with when it began, and its sealed token is deleted at 7 days (the link row stays, so the Operator can drop it).
func TestAnUnconfirmedRemovalIsListedAndItsTokenDeletedAfterSevenDays(t *testing.T) {
	cs, a, b := twoLinks(t)
	ctx := context.Background()
	require.NoError(t, cs.BeginRemoveLink(ctx, a))
	got, err := cs.RemovingLinks(ctx)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, a, got[0].LinkID)
	assert.WithinDuration(t, time.Now(), got[0].Since, time.Minute)

	require.Error(t, cs.DeleteLinkToken(ctx, b), "only a removing link's token is deleted")
	var bEnv string
	require.NoError(t, cs.db.GetContext(ctx, &bEnv, "SELECT token FROM cloud_link WHERE link_id = ?", b))
	assert.NotEmpty(t, bEnv, "the other link keeps its token")

	require.NoError(t, cs.DeleteLinkToken(ctx, a))
	var env string
	require.NoError(t, cs.db.GetContext(ctx, &env, "SELECT token FROM cloud_link WHERE link_id = ?", a))
	assert.Empty(t, env, "no sealed token stays at rest")
	_, err = cs.LinkToken(ctx, a)
	assert.Error(t, err)
	require.NoError(t, cs.DeleteLinkToken(ctx, a), "a repeat is fine")
	ev, _ := cs.ListLinkEvents(ctx, a, 10)
	n := 0
	for _, e := range ev {
		if e.Action == LinkEventTokenDeleted {
			n++
		}
	}
	assert.Equal(t, 1, n, "logged once")
	require.NoError(t, cs.FinishRemoveLink(ctx, a, LinkEventDropped), "the Operator can still drop the link")
}
