package tunnel

import (
	"net/http"
	"sync"
	"sync/atomic"
)

// LinkRequestRelayedOpen is false: a Hub's owner cannot yet Allow a second Hub's request to join, nor make or revoke its request key (#20966, design #20901 v8, goal #269). The three routes below are not in the table at
// all until it is true, so they are `never` exactly as before, and the owner marker is not stamped for them. It changes only in a commit Security reads. It is its own gate: it does not change MemberRelayedOpen or
// any other, and none of them opens it.
const LinkRequestRelayedOpen = false

var (
	linkRelayedOpen atomic.Bool
	linkRelayedMu   sync.Mutex
)

func init() { linkRelayedOpen.Store(LinkRequestRelayedOpen) }

// LinkRelayedIsOpen reports whether the relayed join routes are in the table now.
func LinkRelayedIsOpen() bool { return linkRelayedOpen.Load() }

// OpenLinkRelayedForTest opens the gate for one test and shuts it when the test ends. Nothing but a test calls it; tests that use it do not run in parallel with each other.
func OpenLinkRelayedForTest(t interface{ Cleanup(func()) }) {
	linkRelayedMu.Lock()
	linkRelayedOpen.Store(true)
	t.Cleanup(func() {
		linkRelayedOpen.Store(LinkRequestRelayedOpen)
		linkRelayedMu.Unlock()
	})
}

// linkRelayedRoutes are the owner's three, Interact tier (Allow gives at most Interact, and a key only lets a Hub ask): Allow a waiting request, make a request key, revoke one. Only the Hub's owner is stamped for them
// (OwnerHubOnly) and every one needs the relayed owner signature, checked by the guard and again by the handler. Deny, the feed, the key list and the Hub's own three calls are this computer's alone and are not here.
var linkRelayedRoutes = owner(OwnerHubOnly,
	rules(http.MethodPost, TierInteract, "/api/cloud/link-requests/{id}/allow", "/api/cloud/link-requests/{id}/deny", "/api/cloud/link-keys"),
	rules(http.MethodDelete, TierInteract, "/api/cloud/link-keys/{id}"),
	// The two reads the owner's Inbox needs to Allow through a Hub (#20966): the waiting requests, and the keys this link made. Plain reads: no device signature, no query.
	rules(http.MethodGet, TierInteract, "/api/cloud/link-requests", "/api/cloud/link-keys"),
)

var (
	routeTableLink = cat(linkRelayedRoutes, routeTable)
	routeTableBoth = cat(linkRelayedRoutes, routeTableOpen)
)

// linkRelayedQueries is the one query of the two routes that carry the browser's one-time key: box_pk, once, 43 base64url characters written as they are. It is here and not in the generated table because the generator
// lists only routes the table lets through while the gate is shut. Revoke takes none.
var linkRelayedQueries = map[string]map[string]paramSpec{
	"POST /api/cloud/link-requests/{}/allow": {"box_pk": {kind: paramBoxKey}},
	"POST /api/cloud/link-keys":              {"box_pk": {kind: paramBoxKey}},
}

func boxKeyForm(s string) bool {
	if len(s) != 43 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
