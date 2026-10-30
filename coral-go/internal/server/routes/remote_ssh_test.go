package routes

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/hubowner"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

// fakeSSHOnPath puts a bash script named ssh first on PATH: for `ssh ... -W host:port ...` it joins stdin and stdout to that address, as ssh would over the channel.
func fakeSSHOnPath(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake ssh is a bash script")
	}
	dir := t.TempDir()
	script := `#!/bin/bash
addr=""
while [ $# -gt 0 ]; do if [ "$1" = "-W" ]; then addr="$2"; fi; shift; done
host="${addr%:*}"; port="${addr##*:}"
exec 3<>"/dev/tcp/$host/$port" || exit 255
cat <&3 &
cat >&3
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "ssh"), []byte(script), 0o700))
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func remoteCoral(t *testing.T, key string) (port int) {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		if r.Host != "127.0.0.1:"+strconv.Itoa(r.Context().Value(http.LocalAddrContextKey).(net.Addr).(*net.TCPAddr).Port) {
			http.Error(w, "host refused", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"status":"ok","version":"9.9.9"}`)
	}))
	t.Cleanup(ts.Close)
	return ts.Listener.Addr().(*net.TCPAddr).Port
}

func TestSSHServerIsProbedThroughItsStreamAndKeepsNoURL(t *testing.T) {
	fakeSSHOnPath(t)
	e := newRSEnv(t)
	port := remoteCoral(t, routeSecret)
	ctx := context.Background()
	_, err := e.h.store.AddSSH(ctx, "build", "Build box", "rich@box.example.com:2222", port, "inst-1", routeSecret)
	require.NoError(t, err)

	w := e.do("POST", "/api/servers/build/test", nil)
	require.Equal(t, 200, w.Code, w.Body.String())
	srv, _ := e.h.store.Get(ctx, "build")
	assert.Equal(t, store.RemoteStatusOnline, srv.Status)

	// a URL, or the private switch, cannot be put on it
	for _, body := range []map[string]any{{"url": "http://127.0.0.1:1"}, {"allow_private": true}} {
		w := e.do("PATCH", "/api/servers/build", body)
		assert.Equal(t, 400, w.Code, "%v: %s", body, w.Body.String())
	}
	got, _ := e.h.store.Get(ctx, "build")
	assert.Equal(t, "ssh://rich@box.example.com:2222", got.URL)
	assert.Equal(t, store.RemoteTransportSSH, got.Transport)

	// a label edit works; a wrong key is refused by the health check and not saved
	w = e.do("PATCH", "/api/servers/build", map[string]any{"label": "Renamed"})
	require.Equal(t, 200, w.Code, w.Body.String())
	w = e.do("PATCH", "/api/servers/build", map[string]any{"api_key": "not-the-remote-key"})
	assert.Equal(t, 502, w.Code, w.Body.String())
	assert.NotContains(t, w.Body.String(), "not-the-remote-key")
	if key, _ := e.h.store.DecryptedKey(ctx, "build"); key != routeSecret {
		t.Errorf("a key the remote rejected was saved")
	}
}

func TestResolverGivesAnSSHServerOneSharedStreamTarget(t *testing.T) {
	e := newRSEnv(t)
	ctx := context.Background()
	_, err := e.h.store.AddSSH(ctx, "build", "Build box", "rich@box.example.com", 8420, "inst-1", routeSecret)
	require.NoError(t, err)
	r := NewRemoteResolver(e.h.store)
	a, err := r.Resolve(ctx, "build")
	require.NoError(t, err)
	b, _ := r.Resolve(ctx, "build")
	assert.Same(t, a, b, "each resolve of the poller would start a new set of ssh streams otherwise")
	plain, err := e.h.store.Add(ctx, "web", "By URL", "http://10.0.0.5:8420", routeSecret, true)
	require.NoError(t, err)
	got, err := r.Resolve(ctx, plain.ID)
	require.NoError(t, err)
	_, direct := got.(proxy.HTTPTarget)
	assert.True(t, direct, "a server added by URL is still a direct target")
}

func TestDeletingAnSSHServerDropsItsStreamTarget(t *testing.T) {
	e := newRSEnv(t)
	ctx := context.Background()
	_, err := e.h.store.AddSSH(ctx, "build", "Build box", "rich@box.example.com", 8420, "inst-1", routeSecret)
	require.NoError(t, err)
	r := NewRemoteResolver(e.h.store)
	e.h.SetOnDelete(r.Forget)
	a, err := r.Resolve(ctx, "build")
	require.NoError(t, err)
	require.Len(t, r.streams.m, 1)
	w := e.do("DELETE", "/api/servers/build", nil)
	require.Equal(t, 200, w.Code)
	assert.Empty(t, r.streams.m, "the deleted server's target and its key are still in memory")
	_, err = r.Resolve(ctx, "build")
	assert.Error(t, err)
	_ = a
}

// #11378: the resolver gives each target the owner secret the hub holds for the server, and a rotated secret makes a new stream target.
func TestResolverGivesTargetsTheOwnerSecretTheHubHolds(t *testing.T) {
	e := newRSEnv(t)
	ctx := context.Background()
	secret := strings.Repeat("ab", 32)
	_, err := e.h.store.AddSSH(ctx, "build", "Build box", "rich@box.example.com", 8420, "inst-1", routeSecret)
	require.NoError(t, err)
	_, err = e.h.store.Add(ctx, "web", "By URL", "http://10.0.0.5:8420", routeSecret, true)
	require.NoError(t, err)
	r := NewRemoteResolver(e.h.store)

	// no secret yet: nothing is signed
	a, err := r.Resolve(ctx, "build")
	require.NoError(t, err)
	_, ok := a.(proxy.OwnerStamper).OwnerStamp("POST", "/api/board/t/artifacts/x/review", []byte("{}"))
	assert.False(t, ok)
	w, _ := r.Resolve(ctx, "web")
	assert.Empty(t, w.(proxy.HTTPTarget).OwnerSecret)

	require.NoError(t, e.h.store.SetOwnerSecret(ctx, "build", secret))
	require.NoError(t, e.h.store.SetOwnerSecret(ctx, "web", secret))
	b, err := r.Resolve(ctx, "build")
	require.NoError(t, err)
	assert.NotSame(t, a, b, "a new secret must make a new stream target")
	stamp, ok := b.(proxy.OwnerStamper).OwnerStamp("POST", "/api/board/t/artifacts/x/review", []byte("{}"))
	require.True(t, ok)
	v := hubowner.Verifier{Secret: secret, RemoteID: "build", Start: time.Now().Add(-time.Hour)}
	assert.NoError(t, v.Verify(stamp, "POST", "/api/board/t/artifacts/x/review", "/api/board/t/artifacts/x/review", []byte("{}")), "signed for the id the server is registered under")
	w, _ = r.Resolve(ctx, "web")
	assert.Equal(t, secret, w.(proxy.HTTPTarget).OwnerSecret)
	assert.Equal(t, "web", w.(proxy.HTTPTarget).RemoteID)
	c, _ := r.Resolve(ctx, "build")
	assert.Same(t, b, c, "the same secret keeps the same target")
}
