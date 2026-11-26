package routes

import (
	"context"
	"net/http"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
)

// A self-hosted Hub's request key (#20944, design #20901 v5 to v7) is a credential of its own: sent as X-Link-Request-Key, never as the API key. It is admitted for exactly three calls, the Hub's own join request (create,
// status, finish), and refused everywhere else, in every mode. It never stands for the Operator, an agent or a Hub, and it is refused when sent together with any other credential.

const (
	linkKeyHeader = "X-Link-Request-Key"
	callerLinkKey = "link_key"
)

type linkKeyIDKey struct{}

var (
	linkKeyStatusPath = regexp.MustCompile(`^/api/cloud/link-requests/[^/]+$`)
	linkKeyFinishPath = regexp.MustCompile(`^/api/cloud/link-requests/[^/]+/finish$`)
)

// linkKeyMayCall is the whole of what a request key reaches.
func linkKeyMayCall(method, path string) bool {
	switch {
	case method == http.MethodPost && path == "/api/cloud/link-requests":
		return true
	case method == http.MethodGet && linkKeyStatusPath.MatchString(path):
		return true
	case method == http.MethodPost && linkKeyFinishPath.MatchString(path):
		return true
	}
	return false
}

// serveLinkKey admits or refuses a request that carries a request key. The three join calls are served here; any other request is carried through the key's link (#21220) when the key has one, and refused
// otherwise.
func (o *IdentityObserver) serveLinkKey(w http.ResponseWriter, r *http.Request, next http.Handler, key string) {
	o.count(callerLinkKey)
	joinCall := linkKeyMayCall(r.Method, routedPath(r))
	if !joinCall && o.keyLinks == nil {
		o.refuse(w, http.StatusForbidden, "link_key_scope", "A request key can only start, check and finish its own Hub's request to join")
		return
	}
	if r.Header.Get(cliauth.CLIAuthHeader) != "" || r.Header.Get(store.SessionTokenHeader) != "" || r.Header.Get(store.CheckTokenHeader) != "" ||
		r.Header.Get("Authorization") != "" || r.Header.Get("X-API-Key") != "" || r.URL.Query().Get("api_key") != "" || cloud.Tunneled(r) || len(r.Header.Values(linkKeyHeader)) != 1 {
		o.refuse(w, http.StatusForbidden, "link_key_scope", "A request key is sent alone: no other credential, and never through a Hub")
		return
	}
	id := ""
	if o.linkKey != nil {
		if got, ok := o.linkKey(r.Context(), strings.TrimSpace(key)); ok {
			id = got
		}
	}
	if id == "" {
		// A key that was revoked still has the right secret: a Hub that does not know yet keeps sending it. That is no guess, and every Hub's calls from this computer's loopback share one address, so counting it
		// would lock the other Hubs out (#21645). A wrong or unknown key is counted.
		revoked := o.linkKeyRevoked != nil && o.linkKeyRevoked(r.Context(), strings.TrimSpace(key))
		if o.linkKeyFailed != nil && !revoked {
			o.linkKeyFailed(r)
		}
		if revoked && o.revokedKeyOverCap(r) { // a cap of its own, so a Hub that never learns of its revoke cannot become load (#21660)
			w.Header().Set("Retry-After", "60")
			o.refuse(w, http.StatusTooManyRequests, "revoked_key_rate_limited", "Too many requests with a revoked request key from this address; wait a minute")
			return
		}
		o.refuse(w, http.StatusUnauthorized, "invalid_credential", "That request key is not valid for this Coral: wrong, or revoked")
		return
	}
	if !joinCall {
		// An owner stamp is not checked here: it is carried through the link's tunnel and checked on the far end of it, against the secret held under the hub id this key's link recorded (#21261).
		if o.keyLinks(w, r, id) {
			return
		}
		o.refuse(w, http.StatusForbidden, "link_key_scope", "A request key can only start, check and finish its own Hub's request to join")
		return
	}
	ctx := context.WithValue(r.Context(), callerKindKey{}, callerLinkKey)
	ctx = context.WithValue(ctx, linkKeyIDKey{}, id)
	next.ServeHTTP(w, r.WithContext(ctx))
}

// linkKeyCaller is the id of the request key a request came with ("" when it came with none).
func linkKeyCaller(r *http.Request) string {
	id, _ := r.Context().Value(linkKeyIDKey{}).(string)
	return id
}
