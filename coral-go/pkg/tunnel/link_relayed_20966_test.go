package tunnel

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #20966: a Hub's owner may Allow a second Hub's request to join, and make or revoke that Hub's request key, signed by the owner's own device. The three routes are shut (never, as before) until
// LinkRequestRelayedOpen is true, which changes only in a commit Security reads; open, they are the owner's, Interact tier, and nobody else's. Deny, the feed and the key list stay this computer's.
var linkRelayedCases = []struct{ method, path, query string }{
	{http.MethodPost, "/api/cloud/link-requests/lr-1/allow", "box_pk=" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
	{http.MethodPost, "/api/cloud/link-keys", "box_pk=" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
	{http.MethodDelete, "/api/cloud/link-keys/lk-aaaa1111", ""},
	{http.MethodPost, "/api/cloud/link-requests/lr-1/deny", ""},
}

func TestLinkRoutesAreShutUntilTheRelayedGateOpens(t *testing.T) {
	assert.False(t, LinkRequestRelayedOpen, "ships shut")
	for _, r := range linkRelayedCases {
		assert.Equal(t, TierNever, Classify(r.method, r.path, r.query), "%s %s shut", r.method, r.path)
	}
	OpenLinkRelayedForTest(t)
	for _, r := range linkRelayedCases {
		assert.Equal(t, TierInteract, Classify(r.method, r.path, r.query), "%s %s open", r.method, r.path)
		_, mode := OwnerRoute(r.method, r.path)
		assert.Equal(t, OwnerHubOnly, mode, "%s %s is the owner's, through a Hub only", r.method, r.path)
		assert.True(t, IsRelayedRoute(r.method, r.path), "%s %s takes the relayed signature headers", r.method, r.path)
		assert.True(t, ForwardsDeviceHeaders(r.method, r.path), "%s %s", r.method, r.path)
	}
	// Nothing else of the join is a Hub's, open or shut.
	for _, r := range [][2]string{{http.MethodPost, "/api/cloud/link-requests"}, {http.MethodPost, "/api/cloud/link-requests/lr-1/finish"}, {http.MethodGet, "/api/cloud/link-requests/lr-1"}} {
		assert.Equal(t, TierNever, Classify(r[0], r[1], ""), "%s %s stays this computer's", r[0], r[1])
	}
	assert.Equal(t, TierNever, Classify(http.MethodPost, "/api/cloud/link-keys", "box_pk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&x=1"), "no other parameter")
	assert.Equal(t, TierNever, Classify(http.MethodDelete, "/api/cloud/link-keys/lk-aaaa1111", "x=1"), "revoke takes no query")
}

func TestLinkRelayedGateIsShutAgainAfterATest(t *testing.T) {
	for _, r := range linkRelayedCases {
		assert.Equal(t, TierNever, Classify(r.method, r.path, r.query))
	}
}

func TestTheTwoGatesAreIndependent(t *testing.T) {
	OpenLinkRelayedForTest(t)
	assert.Equal(t, TierNever, Classify(http.MethodPost, "/api/member-grants", ""), "opening the join's gate opens no member route")
	assert.False(t, MemberRelayedIsOpen())
	assert.False(t, strings.Contains(strings.Join(RoutePatterns(), "\n"), "POST /api/member-grants "), "and the table does not list it")
}

// The two reads the owner's Inbox needs to Allow through a Hub (the Orchestrator's call on #20966): the waiting requests and the keys this link made. Plain reads, no device signature, no query; owner only, Interact.
func TestTheOwnersTwoJoinReadsAreShutUntilTheGateOpensAndTakeNoQuery(t *testing.T) {
	reads := []string{"/api/cloud/link-requests", "/api/cloud/link-keys"}
	for _, p := range reads {
		assert.Equal(t, TierNever, Classify(http.MethodGet, p, ""), "GET %s shut", p)
	}
	OpenLinkRelayedForTest(t)
	for _, p := range reads {
		assert.Equal(t, TierInteract, Classify(http.MethodGet, p, ""), "GET %s open", p)
		_, mode := OwnerRoute(http.MethodGet, p)
		assert.Equal(t, OwnerHubOnly, mode, "GET %s is the owner's", p)
		assert.False(t, IsRelayedRoute(http.MethodGet, p), "a read carries no device signature")
		assert.Equal(t, TierNever, Classify(http.MethodGet, p, "x=1"), "GET %s takes no query", p)
	}
}

// #20979: the box key's form is checked here as well as in devicekey.MatchRoute: a short, long or non-base64url key is never a route through the table.
func TestTheTableRefusesABoxKeyThatIsNotExactlyFortyThreeBase64urlCharacters(t *testing.T) {
	OpenLinkRelayedForTest(t)
	good := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	for _, p := range []string{"/api/cloud/link-requests/lr-1/allow", "/api/cloud/link-keys"} {
		assert.Equal(t, TierInteract, Classify(http.MethodPost, p, "box_pk="+good), p)
		for name, q := range map[string]string{"short": "box_pk=" + good[:42], "long": "box_pk=" + good + "A", "not base64url": "box_pk=" + good[:42] + "+", "empty": "box_pk="} {
			assert.Equal(t, TierNever, Classify(http.MethodPost, p, q), "%s %s", p, name)
		}
	}
}
