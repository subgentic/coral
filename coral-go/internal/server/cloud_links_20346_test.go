package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
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

func (f *fakeRevoker) Revoke(_ context.Context, origin, serverID, token string) routes.RevokeResult {
	f.calls = append(f.calls, origin+"|"+serverID+"|"+token)
	return routes.RevokeResult{Answer: f.answer}
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

// The switch is on (#20838): a second link is no longer refused with second_link_not_yet, but a bad cap still is, before any Hub is asked.
func TestAddingASecondLinkIsNotRefusedByTheSwitch(t *testing.T) {
	r, cs, _, _ := linkedRemoteWithManager(t)
	js := map[string]string{"Content-Type": "application/json"}
	require.NoError(t, cs.CheckCanAddLink(context.Background()))
	rec := call(r.srv.Router(), "POST", "/api/cloud/links", `{"hub":"https://hub-b.example.com","cap":"root"}`, js)
	assert.Equal(t, 400, rec.Code, rec.Body.String())
	assert.NotContains(t, rec.Body.String(), "second_link_not_yet")
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

// #20346: each Operator action taken through a Hub shows which Hub it came through, read from the link at that moment (a label and an address as text); a link that was removed shows as one.
func TestOperatorActionsNameTheHubTheyCameThrough(t *testing.T) {
	r, _, l := linkedRemote(t, &fakeRevoker{})
	ctx := context.Background()
	require.NoError(t, r.srv.boardStore.RecordHubOperatorAction(ctx, board.HubOperatorAction{HubUser: "Ann", ViaLink: l.LinkID, ViaHubUser: "hub-user-1234abcd", Method: "POST", Path: "/a", Status: 200}))
	require.NoError(t, r.srv.boardStore.RecordHubOperatorAction(ctx, board.HubOperatorAction{HubUser: "Bob", ViaLink: "lnk-deadbeef", ViaHubUser: "hub-user-9999abcd", Method: "POST", Path: "/b", Status: 200}))
	require.NoError(t, r.srv.boardStore.RecordHubOperatorAction(ctx, board.HubOperatorAction{HubUser: "Cy", Method: "POST", Path: "/c", Status: 200}))
	rec := call(r.srv.Router(), "GET", "/api/system/hub-operator", "", map[string]string{"Content-Type": "application/json"})
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var out struct {
		Recent []struct {
			Path       string `json:"path"`
			ViaHubUser string `json:"via_hub_user"`
			Hub        *struct {
				Label   string `json:"label"`
				Origin  string `json:"origin"`
				Removed bool   `json:"removed"`
				Text    string `json:"text"`
			} `json:"hub"`
		} `json:"recent_actions"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	by := map[string]int{}
	for i, a := range out.Recent {
		by[a.Path] = i
	}
	a, b, c := out.Recent[by["/a"]], out.Recent[by["/b"]], out.Recent[by["/c"]]
	require.NotNil(t, a.Hub)
	assert.Equal(t, l.HubOrigin, a.Hub.Origin)
	assert.Equal(t, "Laptop", a.Hub.Label)
	assert.False(t, a.Hub.Removed)
	assert.Equal(t, "hub-user-1234abcd", a.ViaHubUser)
	require.NotNil(t, b.Hub)
	assert.True(t, b.Hub.Removed)
	assert.Equal(t, "a removed link (lnk-deadbeef)", b.Hub.Text)
	assert.Empty(t, b.Hub.Origin)
	assert.Nil(t, c.Hub, "a local action names no Hub")
}

type seqRevoker struct {
	answers []routes.RevokeResult
	calls   int
}

func (s *seqRevoker) Revoke(context.Context, string, string, string) routes.RevokeResult {
	i := s.calls
	if i >= len(s.answers) {
		i = len(s.answers) - 1
	}
	s.calls++
	return s.answers[i]
}

// A removal the Hub has not confirmed is asked again about every hour (not before), a 429's Retry-After is honoured, and the link ends here when the Hub finally answers.
func TestAnUnconfirmedRemovalIsAskedAgainEveryHourAndEndsWhenTheHubAnswers(t *testing.T) {
	rev := &seqRevoker{answers: []routes.RevokeResult{{Answer: routes.RevokeRetry, RetryAfter: 3 * time.Hour}, {Answer: routes.RevokeRetry}, {Answer: routes.RevokeRemoved}}}
	r, cs, l := linkedRemote(t, rev)
	ctx := context.Background()
	h := r.srv.cloudHandler
	require.NoError(t, cs.BeginRemoveLink(ctx, l.LinkID))
	t0 := time.Now()
	h.RetryRemovals(ctx, t0)
	require.Equal(t, 1, rev.calls, "asked at once the first time")
	h.RetryRemovals(ctx, t0.Add(2*time.Hour))
	require.Equal(t, 1, rev.calls, "the Hub said wait 3 hours")
	h.RetryRemovals(ctx, t0.Add(3*time.Hour+time.Minute))
	require.Equal(t, 2, rev.calls)
	h.RetryRemovals(ctx, t0.Add(3*time.Hour+30*time.Minute))
	require.Equal(t, 2, rev.calls, "not again within the hour")
	ls, _ := cs.ListLinks(ctx)
	require.Len(t, ls, 1)
	assert.Equal(t, store.LinkStateRemoving, ls[0].State)
	h.RetryRemovals(ctx, t0.Add(5*time.Hour))
	require.Equal(t, 3, rev.calls, "about an hour after the last answer, with jitter, never longer than 70 minutes")
	ls, _ = cs.ListLinks(ctx)
	assert.Empty(t, ls, "the Hub confirmed: the link ends here")
}

// At 7 days the sealed token is deleted and the Hub is not asked again; the link stays so the Operator can drop it. A 400 is our bug: asked once, never again.
func TestAnUnconfirmedRemovalGivesUpAtSevenDaysAndABadRequestIsNotRetried(t *testing.T) {
	rev := &seqRevoker{answers: []routes.RevokeResult{{Answer: routes.RevokeRetry}}}
	r, cs, l := linkedRemote(t, rev)
	ctx := context.Background()
	h := r.srv.cloudHandler
	require.NoError(t, cs.BeginRemoveLink(ctx, l.LinkID))
	h.RetryRemovals(ctx, time.Now().Add(7*24*time.Hour+time.Minute))
	assert.Zero(t, rev.calls, "no call at 7 days")
	var env string
	require.NoError(t, r.db.GetContext(ctx, &env, "SELECT token FROM cloud_link WHERE link_id = ?", l.LinkID))
	assert.Empty(t, env, "the token is deleted")
	ls, _ := cs.ListLinks(ctx)
	require.Len(t, ls, 1, "the Operator can still drop it")

	bad := &seqRevoker{answers: []routes.RevokeResult{{Answer: routes.RevokeBadRequest}}}
	r2, cs2, l2 := linkedRemote(t, bad)
	h2 := r2.srv.cloudHandler
	require.NoError(t, cs2.BeginRemoveLink(ctx, l2.LinkID))
	now := time.Now()
	h2.RetryRemovals(ctx, now)
	h2.RetryRemovals(ctx, now.Add(3*time.Hour))
	h2.RetryRemovals(ctx, now.Add(30*time.Hour))
	assert.Equal(t, 1, bad.calls, "400 is not retried")
}

// Security's MUST on #20346: while there is one link, the cap the list shows is the live one (the setting the checks read), however it was set: the max-mode route, the launch flag or Connect write only the setting.
func TestTheLinkListShowsTheLiveCapHoweverItWasSet(t *testing.T) {
	r, cs, _ := linkedRemote(t, &fakeRevoker{})
	js := map[string]string{"Content-Type": "application/json"}
	h := r.srv.Router()
	listed := func() string {
		rec := call(h, "GET", "/api/cloud/links", "", js)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		var body struct {
			Links []struct {
				MaxMode string `json:"max_mode"`
			} `json:"links"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Len(t, body.Links, 1)
		return body.Links[0].MaxMode
	}
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"launch"}`, js).Code)
	assert.Equal(t, "launch", listed(), "set through PUT /api/cloud/max-mode")
	// The start-up flag writes the same setting directly.
	_, err := r.db.ExecContext(context.Background(), "INSERT INTO user_settings (key, value) VALUES ('cloud_max_mode', 'interact') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
	require.NoError(t, err)
	assert.Equal(t, "interact", listed(), "set by the start-up flag")
	ls, err := cs.ListLinks(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "interact", ls[0].MaxMode, "the store's own list agrees")
}

// #20368: with two links, one link's removal never touches the other: its row, sealed token, cap and (for the enrollment's link) the enrollment itself stay, and the Manager keeps the other's connector.
func twoLinkedRemote(t *testing.T) (*e2eRemote, *store.CloudStore, *cloud.Manager, store.CloudLink, store.CloudLink, *fakeRevoker) {
	t.Helper()
	rev := &fakeRevoker{answer: routes.RevokeRemoved}
	r, cs, a := linkedRemote(t, rev)
	store.AllowSecondLinkForTest(t)
	b, err := cs.AddLink(context.Background(), "https://hub-b.example.com", "srv_b", "Laptop B", "tok-b", "interact")
	require.NoError(t, err)
	refuse := &http.Client{Transport: &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("no network in this test")
	}}}
	m := cloud.New(cloud.Options{HubURL: a.HubOrigin, Store: cs, HTTPClient: refuse, LocalBaseURL: "http://127.0.0.1:1", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Backoff: tunnel.Backoff{Min: time.Hour, Max: time.Hour}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	require.Eventually(t, func() bool { return !m.Status().Loading }, 5*time.Second, 5*time.Millisecond)
	r.srv.cloudHandler.SetManager(m)
	return r, cs, m, a, *b, rev
}

func TestRemovingTheAddedLinkLeavesTheEnrollmentsLinkAndItsToken(t *testing.T) {
	r, cs, m, a, b, rev := twoLinkedRemote(t)
	ctx := context.Background()
	js := map[string]string{"Content-Type": "application/json"}
	require.Equal(t, 200, call(r.srv.Router(), "DELETE", "/api/cloud/links/"+b.LinkID, "", js).Code)
	require.Equal(t, []string{b.HubOrigin + "|srv_b|tok-b"}, rev.calls, "only B's own token, to B's own Hub")
	ls, _ := cs.ListLinks(ctx)
	require.Len(t, ls, 1)
	assert.Equal(t, a.LinkID, ls[0].LinkID)
	tok, err := cs.LinkToken(ctx, a.LinkID)
	require.NoError(t, err)
	assert.Equal(t, "tok-a", tok)
	conn, err := cs.Get(ctx)
	require.NoError(t, err, "the enrollment of A is not disconnected by B's removal")
	assert.Equal(t, "srv_a", conn.ServerID)
	assert.NotEqual(t, cloud.StateOff, m.Status().State)
	assert.Equal(t, cloud.StateIdle, m.LinkStatus(b.LinkID).State)
}

func TestRemovingTheEnrollmentsLinkLeavesTheAddedLink(t *testing.T) {
	r, cs, m, a, b, rev := twoLinkedRemote(t)
	ctx := context.Background()
	js := map[string]string{"Content-Type": "application/json"}
	require.Equal(t, 200, call(r.srv.Router(), "DELETE", "/api/cloud/links/"+a.LinkID, "", js).Code)
	require.Equal(t, []string{a.HubOrigin + "|srv_a|tok-a"}, rev.calls)
	ls, _ := cs.ListLinks(ctx)
	require.Len(t, ls, 1)
	assert.Equal(t, b.LinkID, ls[0].LinkID)
	tok, err := cs.LinkToken(ctx, b.LinkID)
	require.NoError(t, err)
	assert.Equal(t, "tok-b", tok)
	assert.Equal(t, "interact", ls[0].MaxMode)
	assert.NotEqual(t, cloud.StateIdle, m.LinkStatus(b.LinkID).State, "B keeps its own connector")
	assert.Equal(t, store.LinkStateActive, ls[0].State)
}
