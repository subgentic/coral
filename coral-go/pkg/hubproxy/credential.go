package hubproxy

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// A remote this hub joined with a request key (#21220, design B) is reached with that key, not an API key: the remote's identity layer checks it and lets it reach the remote at the cap its person
// allowed. The key goes in its own header, never as Authorization, and only over https or to this computer (Security's MUST 6 on #21220).

// LinkKeyHeader carries a request key (the remote reads the same name: auth.LinkKeyHeader).
const LinkKeyHeader = "X-Link-Request-Key"

// ErrLinkKeyPlainHTTP is a request key that would cross the network unencrypted: refused before anything is sent.
var ErrLinkKeyPlainHTTP = errors.New("a computer joined with a request key is reached only over https, or at this computer's own address: register it with an https address")

// IsLinkKey is whether key is a request key ("lrk_<id>_<secret>", store.CreateLinkKey) rather than an API key.
func IsLinkKey(key string) bool { return strings.HasPrefix(key, "lrk_") }

// SetCredential puts key on h as the remote expects it: a request key in LinkKeyHeader (and no Authorization), any other key as a Bearer API key.
func SetCredential(h http.Header, key string) {
	if IsLinkKey(key) {
		h.Del("Authorization")
		h.Set(LinkKeyHeader, key)
		return
	}
	h.Del(LinkKeyHeader)
	h.Set("Authorization", "Bearer "+key)
}

// KeySafeURL is whether a key may be sent to raw: https always, plain http only to this computer (localhost or a loopback address).
func KeySafeURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch u.Scheme {
	case "https", "wss":
		return true
	case "http", "ws":
	default:
		return false
	}
	h := u.Hostname()
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// checkLinkKeyURL refuses a request key bound for a URL that is not KeySafeURL; any other key passes (an API key's own rule is the registration's).
func checkLinkKeyURL(key, raw string) error {
	if IsLinkKey(key) && !KeySafeURL(raw) {
		return ErrLinkKeyPlainHTTP
	}
	return nil
}
