package background

import (
	"context"
	"net"
	"net/url"
	"strings"

	"github.com/subgentic/coral/internal/store"
)

// RemoteKeyRegistry is the part of store.RemoteServerStore the poller's key lookup needs.
type RemoteKeyRegistry interface {
	List(ctx context.Context) ([]store.RemoteServer, error)
	DecryptedKey(ctx context.Context, id string) (string, error)
}

// RemoteKeyFor returns the lookup the remote board poller sends its Authorization from (#13695, G7): the API key of the registered server whose URL is EXACTLY the subscription's server
// (one trailing slash aside), and nothing for any other address: no prefix match, no host match, an ssh server (its URL is not an address to dial) never. A server with no readable key gives none,
// and the poll goes without, as it did. A key is never sent over plain http to a host that is not this computer (Security's INFO on #13695): it would cross the network in clear, so such a
// server is polled without it (register it as https://). Documented here because nothing else describes the poll.
func RemoteKeyFor(reg RemoteKeyRegistry) func(ctx context.Context, remoteURL string) (string, bool) {
	return func(ctx context.Context, remoteURL string) (string, bool) {
		servers, err := reg.List(ctx)
		if err != nil {
			return "", false
		}
		want := strings.TrimSuffix(remoteURL, "/")
		for _, s := range servers {
			if s.Transport == "ssh" || strings.TrimSuffix(s.URL, "/") != want {
				continue
			}
			if !keySafeURL(s.URL) {
				return "", false
			}
			key, err := reg.DecryptedKey(ctx, s.ID)
			if err != nil || key == "" {
				return "", false
			}
			return key, true
		}
		return "", false
	}
}

// keySafeURL is whether a key may be sent to this URL: https always, plain http only to this computer (localhost or a loopback address).
func keySafeURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	if u.Scheme != "http" {
		return false
	}
	h := u.Hostname()
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
