package background

import (
	"context"
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
// and the poll goes without, as it did.
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
			key, err := reg.DecryptedKey(ctx, s.ID)
			if err != nil || key == "" {
				return "", false
			}
			return key, true
		}
		return "", false
	}
}
