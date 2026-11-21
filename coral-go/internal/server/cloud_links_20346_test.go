package server

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// fakeRevoker stands in for the Hub's unlink call (design v2 slice 2): it records what it was given and answers as told.
type fakeRevoker struct {
	answer routes.RevokeAnswer
	calls  []string
}

func (f *fakeRevoker) Revoke(_ context.Context, origin, serverID, token string) routes.RevokeAnswer {
	f.calls = append(f.calls, origin+"|"+serverID+"|"+token)
	return f.answer
}

func linkedRemote(t *testing.T, rev routes.HubRevoker) (*e2eRemote, *store.CloudStore, store.CloudLink) {
	t.Helper()
	r := newE2ERemote(t, "links-20346", nil)
	cs := store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.cfg.CoralDir()))
	_, err := r.db.ExecContext(context.Background(), "DELETE FROM cloud_link") // the test server seeds a stamp link with no token; this test enrols for real
	require.NoError(t, err)
	require.NoError(t, cs.Save(context.Background(), "https://hub-a.example.com", "srv_a", "Laptop", "tok-a"))
	links, err := cs.ListLinks(context.Background())
	require.NoError(t, err)
	require.Len(t, links, 1)
	r.srv.cloudHandler.SetLinkRevoker(rev)
	return r, cs, links[0]
}

// #20346, Security 2: the four link routes are the person at this computer's, never tunneled at any mode.
func TestLinkRoutesAreLocalOnlyAndNeverTunneled(t *testing.T) {
	r, _, l := linkedRemote(t, &fakeRevoker{})
	h := r.srv.Router()
	hub := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	for _, rt := range [][3]string{
		{"GET", "/api/cloud/links", ""},
		{"POST", "/api/cloud/links", `{"hub":"https://hub-b.example.com","cap":"view"}`},
		{"PUT", "/api/cloud/links/" + l.LinkID + "/cap", `{"mode":"view"}`},
		{"DELETE", "/api/cloud/links/" + l.LinkID, ""},
	} {
		assert.Equal(t, tunnel.TierNever, tunnel.Classify(rt[0], rt[1], ""), rt[0]+" "+rt[1])
		assert.Equal(t, 403, call(h, rt[0], rt[1], rt[2], hub).Code, "never through the hub: %s %s", rt[0], rt[1])
	}
	cs := store.NewCloudStore(r.db, nil)
	got, err := cs.LinkByOrigin(context.Background(), l.HubOrigin)
	require.NoError(t, err)
	assert.Equal(t, l, *got, "nothing the hub sent changed anything")
	ev, _ := cs.ListLinkEvents(context.Background(), l.LinkID, 5)
	assert.Empty(t, ev)
}

// The list has safe fields only: no token, no account, no hub-user of anyone.
func TestLinkListShowsSafeFieldsOnly(t *testing.T) {
	r, cs, l := linkedRemote(t, &fakeRevoker{})
	tok, _ := cs.LinkToken(context.Background(), l.LinkID)
	js := map[string]string{"Content-Type": "application/json"}
	rec := call(r.srv.Router(), "GET", "/api/cloud/links", "", js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	body := rec.Body.String()
	assert.Contains(t, body, l.LinkID)
	assert.Contains(t, body, l.HubOrigin)
	for _, no := range []string{tok, "token", "owner_user", "owner_account", "hub-user-", "hub_user"} {
		assert.False(t, strings.Contains(body, no), "the list must not carry %q: %s", no, body)
	}
}

// The cap of one link is lowered here, logged with the Hub, and a bad mode changes nothing.
func TestSettingALinkCapIsLogged(t *testing.T) {
	r, cs, l := linkedRemote(t, &fakeRevoker{})
	js := map[string]string{"Content-Type": "application/json"}
	h := r.srv.Router()
	require.Equal(t, 400, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"root"}`, js).Code)
	require.Equal(t, 404, call(h, "PUT", "/api/cloud/links/lnk-ffffffff/cap", `{"mode":"launch"}`, js).Code)
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/links/"+l.LinkID+"/cap", `{"mode":"launch"}`, js).Code)
	got, err := cs.LinkByOrigin(context.Background(), l.HubOrigin)
	require.NoError(t, err)
	assert.Equal(t, "launch", got.MaxMode)
	ev, err := cs.ListLinkEvents(context.Background(), l.LinkID, 5)
	require.NoError(t, err)
	require.NotEmpty(t, ev)
	assert.Equal(t, store.LinkEventCap, ev[0].Action)
	assert.Equal(t, l.HubOrigin, ev[0].HubOrigin)
}

// A second link is refused while the switch is off, so lifting it is its own reviewed change (Security 1).
func TestAddingASecondLinkIsRefusedForNow(t *testing.T) {
	r, cs, _ := linkedRemote(t, &fakeRevoker{})
	js := map[string]string{"Content-Type": "application/json"}
	rec := call(r.srv.Router(), "POST", "/api/cloud/links", `{"hub":"https://hub-b.example.com","cap":"view"}`, js)
	assert.Equal(t, 409, rec.Code, rec.Body.String())
	ls, _ := cs.ListLinks(context.Background())
	assert.Len(t, ls, 1)
}

// Removing: the Hub's answer decides whether the link ends now or waits, and the token goes only to the stored origin.
func TestRemovingALinkFollowsTheHubsAnswer(t *testing.T) {
	for name, c := range map[string]struct {
		answer   routes.RevokeAnswer
		gone     bool
		wantCode int
		say      string
	}{
		"removed":      {routes.RevokeRemoved, true, 200, ""},
		"already gone": {routes.RevokeAlreadyGone, true, 200, ""},
		"not found":    {routes.RevokeNotFound, true, 200, ""},
		"token refused": {routes.RevokeTokenRefused, true, 200,
			"the Hub did not accept this computer's token; if it still lists this computer, remove it there"},
		"forbidden":   {routes.RevokeForbidden, false, 202, "waiting"},
		"busy":        {routes.RevokeRetry, false, 202, "waiting"},
		"no call yet": {routes.RevokeUnsupported, true, 200, "the Hub still lists this computer"},
	} {
		t.Run(name, func(t *testing.T) {
			rev := &fakeRevoker{answer: c.answer}
			r, cs, l := linkedRemote(t, rev)
			tok, terr := cs.LinkToken(context.Background(), l.LinkID)
			require.NoError(t, terr)
			js := map[string]string{"Content-Type": "application/json"}
			rec := call(r.srv.Router(), "DELETE", "/api/cloud/links/"+l.LinkID, "", js)
			require.Equal(t, c.wantCode, rec.Code, rec.Body.String())
			if c.say != "" {
				assert.Contains(t, rec.Body.String(), c.say)
			}
			require.Equal(t, []string{l.HubOrigin + "|" + l.ServerID + "|" + tok}, rev.calls, "the sealed token goes to the stored origin only")
			ls, _ := cs.ListLinks(context.Background())
			if c.gone {
				assert.Empty(t, ls)
			} else {
				require.Len(t, ls, 1)
				assert.Equal(t, store.LinkStateRemoving, ls[0].State)
			}
		})
	}
}
