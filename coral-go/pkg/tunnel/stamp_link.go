package tunnel

import (
	"net/http"
	"regexp"
)

// The link stamp (#20312, multi-Hub design v2 2.5): which Hub link a forwarded request arrived on, and which Hub person is behind it. Both are the connector's own words, set after scrub
// from what it knows of the connection, never read from the request: a Hub cannot send either header in any spelling, and the local server honours them only beside the connector's
// per-process via secret.
const (
	// LinkHeader carries the id of the cloud_link whose own token authenticated this tunnel (lnk-<8 hex>). It is on every forwarded request, HTTP and WebSocket.
	LinkHeader = "X-Coral-Hub-Link"
	// ActorHeader carries the Hub person's label (hub-user-<8 hex>) from the stream, on a write only. It is attribution and nothing else: no tier, owner, grant or Allow answer may read it
	// as authority (the owner stamp stays the only authority). It is separate from HubUserHeader, whose behaviour is unchanged.
	ActorHeader = "X-Coral-Hub-Actor"
)

var linkIDValue = regexp.MustCompile(`^lnk-[0-9a-f]{8}$`)

// ValidLinkID reports whether s is a link id as this Coral makes them.
func ValidLinkID(s string) bool { return len(s) == 12 && linkIDValue.MatchString(s) }

// stampLink sets LinkHeader to the connection's link id, after removing whatever the request carried. A connection with no well-formed id stamps nothing: the server refuses such a tunneled
// request, so no request is ever served without a link.
func stampLink(out http.Header, linkID string) {
	out.Del(LinkHeader)
	if ValidLinkID(linkID) {
		out.Set(LinkHeader, linkID)
	}
}

// stampActor sets ActorHeader from the stream's own HubUser on a request that changes something (not GET or HEAD), after removing whatever the request carried. No well-formed label, no header.
func stampActor(out http.Header, h Header, method string) {
	out.Del(ActorHeader)
	if method == http.MethodGet || method == http.MethodHead || !ValidHubUser(h.HubUser) {
		return
	}
	out.Set(ActorHeader, h.HubUser)
}

// stampActorWS sets ActorHeader on a WebSocket upgrade from the stream's own HubUser, after removing whatever the request carried (#20405). An upgrade is a GET and stampActor leaves a GET with no actor, but a
// terminal stream carries keystrokes: the computer records the (link, Hub person) pair at connect and at close, and the person can only come from here. It is attribution only, as for a write.
func stampActorWS(out http.Header, h Header) {
	out.Del(ActorHeader)
	if ValidHubUser(h.HubUser) {
		out.Set(ActorHeader, h.HubUser)
	}
}
