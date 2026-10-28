package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/peercred"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #9782 / #9803: every new loopback connection whose request needs the verdict costs a read of the kernel's whole socket table (about 3 ms on macOS). A request with a valid agent session
// token already skipped it with strict local auth on; with it off, strictFor asked first and every tokened call read. This counts the reads per request class on real loopback connections, in
// both modes, and checks that a command-line signature on a tokened request is never treated as signed.
func TestIdentityPeerReadsPerRequestClass(t *testing.T) {
	_, bh := setupBoardTestServer(t)
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	defer db.Close()
	ctx := context.Background()
	_, err = bh.bs.Subscribe(ctx, "p", "Dev", "Developer", "claude-dev", nil, "")
	require.NoError(t, err)
	token, err := db.MintSessionToken(ctx, "sid-dev", "claude-dev")
	require.NoError(t, err)

	for _, strict := range []bool{true, false} {
		name := "strict off"
		if strict {
			name = "strict on"
		}
		t.Run(name, func(t *testing.T) {
			o := NewIdentityObserver(db, bh.bs, func(*http.Request) bool { return false })
			cliCalls := 0
			o.SetVerifiers(
				func(r *http.Request) bool { return r.Header.Get("Authorization") == "Bearer good-key" },
				func(r *http.Request) (*http.Request, bool) {
					cliCalls++
					if r.Header.Get(cliauth.CLIAuthHeader) == "good" {
						return cliauth.WithVerified(r), true
					}
					return r, false
				})
			if strict {
				o.SetStrict()
			}
			var sawSignature, sawVerified bool
			h := o.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sawSignature = r.Header.Get(cliauth.CLIAuthHeader) != ""
				sawVerified = cliauth.Verified(r)
			}))
			var reads atomic.Int32
			t.Cleanup(auth.SetPeerAttribution(func(netip.AddrPort, netip.AddrPort) (peercred.Verdict, error) {
				reads.Add(1)
				return peercred.Self, nil
			}))
			ts := httptest.NewUnstartedServer(h)
			ts.Config.ConnContext = auth.ConnContext
			ts.Start()
			t.Cleanup(ts.Close)

			// Each request on its own connection, as each agent tool call is a new process.
			get := func(method, path string, hdr map[string]string) int {
				client := &http.Client{Transport: &http.Transport{}}
				defer client.CloseIdleConnections()
				req, err := http.NewRequest(method, ts.URL+path, nil)
				require.NoError(t, err)
				for k, v := range hdr {
					req.Header.Set(k, v)
				}
				resp, err := client.Do(req)
				require.NoError(t, err)
				resp.Body.Close()
				return int(reads.Swap(0))
			}
			tok := map[string]string{store.SessionTokenHeader: token, "User-Agent": "coral-board/dev"}
			signed := map[string]string{store.SessionTokenHeader: token, "User-Agent": "coral-board/dev", cliauth.CLIAuthHeader: "good"}

			assert.Zero(t, get("GET", "/api/board/p/messages?subscriber_id=Dev", tok), "a valid session token reads nothing")
			assert.Zero(t, get("GET", "/api/board/p/messages?subscriber_id=Dev", signed), "a valid token with a signature reads nothing")
			assert.False(t, sawSignature, "the handler never sees a signature on a tokened request")
			assert.False(t, sawVerified, "and it is never treated as signed")
			assert.Zero(t, cliCalls, "the signature is never even checked")
			assert.Zero(t, get("GET", "/api/system/status", map[string]string{"Authorization": "Bearer good-key"}), "an API key reads nothing")

			// The classes that still read, once per connection: they need the verdict.
			assert.Equal(t, 1, get("GET", "/api/system/status", nil), "a request with no credential asks whose connection it is")
		})
	}
}
