package tunnel

import (
	"net/http"
	"strings"
)

// The device key's signature headers (coral-hub device keys, step 1, #16654): the Hub signs a request on a computer's owner routes with the computer's device key and sends the public key, signature,
// time and nonce beside it. In step 1 they are EVIDENCE only: they cross the tunnel so a later step can check them, and nothing here or in the server trusts them or serves differently because of them.
// They are never copied into an identity header (X-Coral-Hub-User, the team or guide headers).
const (
	DeviceKeyHeader   = "Coral-Device-Key"
	DeviceSigHeader   = "Coral-Device-Sig"
	DeviceTsHeader    = "Coral-Device-Ts"
	DeviceNonceHeader = "Coral-Device-Nonce"

	// DeviceHeaderMaxValue is the longest value of one of the four (a base64 key or signature is under 100 bytes): a longer one is not a device header, and the four go together or not at all.
	DeviceHeaderMaxValue = 256
)

// DeviceHeaders are the four names, in canonical form.
var DeviceHeaders = [4]string{DeviceKeyHeader, DeviceSigHeader, DeviceTsHeader, DeviceNonceHeader}

// ForwardsDeviceHeaders reports whether the device headers are forwarded for a request: a write (not GET or HEAD) to an owner route of the table, the routes the Hub stamps the owner on, or to a route of a relayed
// signed kind (RelayedRoutes, #20879), and nothing else (scoped as Idempotency-Key is). The hub (pkg/hubproxy) and the connector apply the same rule.
func ForwardsDeviceHeaders(method, decodedPath string) bool {
	if method == http.MethodGet || method == http.MethodHead {
		return false
	}
	return IsOwnerRoute(method, decodedPath) || IsRelayedRoute(method, decodedPath)
}

// RelayedRoute is one route a relayed (v3) signed kind may carry: a method and a path pattern whose {name} segments each match one non-empty segment.
type RelayedRoute struct{ Method, Pattern string }

// relayedRoutes is a copy of devicekey.KindRoutes (this package cannot import it): the routes a Hub may carry a signed request on. A test in internal/devicekey keeps the two equal.
var relayedRoutes = []RelayedRoute{
	{"PUT", "/api/board/{project}/guide-roster"},
	{"PUT", "/api/board/{project}/orchestrator-grant"},
	{"PUT", "/api/artifacts/{id}/trust-preview"},
	{"DELETE", "/api/artifacts/{id}/trust-preview"},
	{"PUT", "/api/teams/detail/{name}/daily-knowledge"},
	{"PUT", "/api/teams/detail/{name}/daily-knowledge/auto-apply"},
	{"POST", "/api/teams/detail/{name}/daily-knowledge/accept"},
	{"POST", "/api/teams/detail/{name}/daily-knowledge/revert"},
	{"POST", "/api/sessions/live/{name}/send"},
	{"POST", "/api/board/{project}/messages"},
	{"POST", "/api/sessions/live/{name}/keep-full-access"},
	{"POST", "/api/hub-auto-accept"},
	{"POST", "/api/member-grants"},
	{"DELETE", "/api/member-grants/{id}"},
	{"POST", "/api/board/{project}/member-grants"},
	{"DELETE", "/api/board/{project}/member-grants/{id}"},
	{"POST", "/api/cloud/link-requests/{id}/allow"},
	{"POST", "/api/cloud/link-keys"},
	{"DELETE", "/api/cloud/link-keys/{id}"},
}

// RelayedRoutes lists the routes of the relayed signed kinds, for the test that keeps them equal to devicekey.KindRoutes.
func RelayedRoutes() []RelayedRoute { return append([]RelayedRoute(nil), relayedRoutes...) }

// IsRelayedRoute reports whether (method, decodedPath) is one of the routes of RelayedRoutes: the same method, the same number of segments, every fixed segment equal and every {name} segment non-empty.
func IsRelayedRoute(method, decodedPath string) bool {
	path := strings.Split(decodedPath, "/")
	for _, r := range relayedRoutes {
		if r.Method != method {
			continue
		}
		pat := strings.Split(r.Pattern, "/")
		if len(pat) != len(path) {
			continue
		}
		ok := true
		for i, seg := range pat {
			if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
				ok = path[i] != ""
			} else {
				ok = seg == path[i]
			}
			if !ok {
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// IsDeviceHeader reports whether a header key, as written, is one of the four (compared in canonical form, so "coral-device-key" is one too).
func IsDeviceHeader(key string) bool {
	c := http.CanonicalHeaderKey(key)
	for _, n := range DeviceHeaders {
		if c == n {
			return true
		}
	}
	return false
}

// StripDeviceHeaders removes the four names, whatever their spelling, from h.
func StripDeviceHeaders(h http.Header) {
	for k := range h {
		if IsDeviceHeader(k) {
			delete(h, k)
		}
	}
}

// keepWholeDeviceSet leaves the device headers on h only when all four are there, one value each, none empty or longer than DeviceHeaderMaxValue; otherwise it removes all four (a half or oversized
// set is not evidence of anything). h is already in canonical form (scrub's output).
func keepWholeDeviceSet(h http.Header) {
	for _, n := range DeviceHeaders {
		vs := h[n]
		if len(vs) != 1 || vs[0] == "" || len(vs[0]) > DeviceHeaderMaxValue {
			StripDeviceHeaders(h)
			return
		}
	}
}

// DeviceHeaderMayStay is allowlistHeaders' check on the hub side: a header that is not a device header may stay as far as this rule goes; a device header only on the routes of ForwardsDeviceHeaders.
func DeviceHeaderMayStay(canon, method, decodedPath string) bool {
	return !IsDeviceHeader(canon) || ForwardsDeviceHeaders(method, decodedPath)
}
