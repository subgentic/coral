package tunnel

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20312: the link and the actor are the connector's own words. A Hub's copy of either, in any spelling, never reaches the local server; the connection's own id and the stream's own label do.
func TestTheLinkAndActorHeadersAreNotOnTheAllowlist(t *testing.T) {
	for _, name := range []string{LinkHeader, ActorHeader} {
		assert.False(t, forwardRequestHeaders[name], name)
		for _, spelled := range []string{name, "x-coral-hub-link", "X-CORAL-HUB-LINK", "x-coral-hub-actor", "X-CORAL-HUB-ACTOR"} {
			in := http.Header{spelled: {"lnk-00000000", "hub-user-00000000"}}
			out := scrub(in, http.MethodPost, "/api/board/t/messages")
			assert.Empty(t, out.Values(LinkHeader), spelled)
			assert.Empty(t, out.Values(ActorHeader), spelled)
		}
	}
}

func TestValidLinkIDIsExactlyItsShape(t *testing.T) {
	assert.True(t, ValidLinkID("lnk-0123abcd"))
	for _, bad := range []string{"", "lnk-", "lnk-0123abc", "lnk-0123abcde", "lnk-0123ABCD", "LNK-0123abcd", "lnk-0123abcg", " lnk-0123abcd", "lnk-0123abcd\n", "hub-user-0123abcd"} {
		assert.False(t, ValidLinkID(bad), "%q", bad)
	}
}

func TestStampLinkReplacesWhateverWasThereAndStampsNothingForABadID(t *testing.T) {
	out := http.Header{LinkHeader: {"lnk-ffffffff", "lnk-eeeeeeee"}}
	stampLink(out, "lnk-0123abcd")
	assert.Equal(t, []string{"lnk-0123abcd"}, out.Values(LinkHeader))
	stampLink(out, "")
	assert.Empty(t, out.Values(LinkHeader), "no id, no header, and no copy of an old one")
	stampLink(out, "lnk-NOPE")
	assert.Empty(t, out.Values(LinkHeader))
}

func TestStampActorIsFromTheStreamOnAWriteOnly(t *testing.T) {
	h := Header{HubUser: "hub-user-1234abcd"}
	for _, tc := range []struct {
		method string
		hub    string
		want   string
	}{
		{http.MethodPost, "hub-user-1234abcd", "hub-user-1234abcd"},
		{http.MethodPut, "hub-user-1234abcd", "hub-user-1234abcd"},
		{http.MethodPatch, "hub-user-1234abcd", "hub-user-1234abcd"},
		{http.MethodDelete, "hub-user-1234abcd", "hub-user-1234abcd"},
		{http.MethodGet, "hub-user-1234abcd", ""},
		{http.MethodHead, "hub-user-1234abcd", ""},
		{http.MethodPost, "", ""},
		{http.MethodPost, "Operator", ""},
		{http.MethodPost, "hub-user-1234ABCD", ""},
	} {
		h.HubUser = tc.hub
		out := http.Header{ActorHeader: {"hub-user-ffffffff"}} // a copy the request carried is removed first
		stampActor(out, h, tc.method)
		if tc.want == "" {
			assert.Empty(t, out.Values(ActorHeader), "%s %q", tc.method, tc.hub)
		} else {
			assert.Equal(t, []string{tc.want}, out.Values(ActorHeader), "%s %q", tc.method, tc.hub)
		}
	}
}

// End to end, through a real tunnel: the id of the connection reaches the local server on HTTP, a Hub's forged copies are replaced, and two connections stamp their own ids.
func TestTheConnectionsLinkReachesTheServerAndAForgeryDoesNot(t *testing.T) {
	run := func(linkID string) (gotLink, gotActor []string) {
		var mu sync.Mutex
		local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			gotLink, gotActor = r.Header.Values(LinkHeader), r.Header.Values(ActorHeader)
			mu.Unlock()
			w.WriteHeader(200)
		})
		hub := newHub(t, fastCfg())
		launch := func() Mode { return TierLaunch }
		sess, _ := connect(t, hub, local, func(l *LocalHandler) {
			l.MaxMode = launch
			l.AllowPath = nil
			l.AllowRequest = AllowRequest(launch)
			l.LinkID = linkID
		})
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		ctx = WithHubUser(WithHubTier(ctx, "launch"), "hub-user-1234abcd")
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://x/api/board/t/messages", nil)
		req.Header["X-Coral-Hub-Link"] = []string{"lnk-ffffffff"}
		req.Header["x-coral-hub-actor"] = []string{"hub-user-ffffffff"}
		resp, err := sess.RoundTrip(req)
		require.NoError(t, err)
		resp.Body.Close()
		mu.Lock()
		defer mu.Unlock()
		return gotLink, gotActor
	}
	link, actor := run("lnk-0123abcd")
	assert.Equal(t, []string{"lnk-0123abcd"}, link, "the connection's own id, not the Hub's copy")
	assert.Equal(t, []string{"hub-user-1234abcd"}, actor, "the stream's label, not the Hub's copy")
	link, _ = run("lnk-89abcdef")
	assert.Equal(t, []string{"lnk-89abcdef"}, link, "another connection stamps its own id")
	link, actor = run("")
	assert.Empty(t, link, "no link id: no stamp and no forged copy; the server refuses it")
	assert.Equal(t, []string{"hub-user-1234abcd"}, actor)
}
