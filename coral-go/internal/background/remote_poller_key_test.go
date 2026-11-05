package background

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

type fakeKeyRegistry struct {
	servers []store.RemoteServer
	keys    map[string]string
}

func (f fakeKeyRegistry) List(context.Context) ([]store.RemoteServer, error) { return f.servers, nil }
func (f fakeKeyRegistry) DecryptedKey(_ context.Context, id string) (string, error) {
	k, ok := f.keys[id]
	if !ok {
		return "", store.ErrRemoteNotFound
	}
	return k, nil
}

// G7 (#13695): a remote that protects its API with a key answers 401 to a poll with no Authorization. The poll carries the registered key, to the registered URL only.
func pollOnce(t *testing.T, reg RemoteKeyRegistry, urlOf func(serverURL string) string) (auth []string, nudged int) {
	t.Helper()
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		auth = append(auth, r.Header.Get("Authorization"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer sekret-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"unread":2}`))
	}))
	defer srv.Close()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	defer db.Close()
	rb := store.NewRemoteBoardStore(db)
	ctx := context.Background()
	_, err = rb.AddRemoteSub(ctx, "sess-1", srv.URL, "team", "Dev")
	require.NoError(t, err)
	rt := &mockRuntime{}
	p := NewRemoteBoardPoller(rb, rt, time.Hour)
	p.validateAddr = func(string) (string, error) { return "127.0.0.1", nil }
	p.validateURL = func(string) (string, error) { return "203.0.113.1", nil }
	if reg != nil {
		p.SetKeyFor(RemoteKeyFor(registryAt(reg, srv.URL, urlOf)))
	}
	p.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentName: "claude", AgentType: "claude", SessionID: "sess-1"}}, nil
	})
	require.NoError(t, p.RunOnce(ctx))
	rt.mu.Lock()
	defer rt.mu.Unlock()
	mu.Lock()
	defer mu.Unlock()
	return auth, len(rt.sent)
}

// registryAt gives the fake registry one server whose URL is urlOf(the test server's URL).
func registryAt(reg RemoteKeyRegistry, serverURL string, urlOf func(string) string) RemoteKeyRegistry {
	f := reg.(fakeKeyRegistry)
	f.servers = []store.RemoteServer{{ID: "r1", URL: urlOf(serverURL), Transport: "http"}}
	return f
}

func TestRemoteBoardPollerSendsTheRegisteredKeyToTheExactURL(t *testing.T) {
	reg := fakeKeyRegistry{keys: map[string]string{"r1": "sekret-key"}}
	auth, nudged := pollOnce(t, reg, func(u string) string { return u })
	assert.Equal(t, []string{"Bearer sekret-key"}, auth, "the poll carries the key")
	assert.Equal(t, 1, nudged, "a key-protected remote is read, so the agent is nudged")
	auth, nudged = pollOnce(t, reg, func(u string) string { return u + "/" })
	assert.Equal(t, []string{"Bearer sekret-key"}, auth, "one trailing slash on the registered URL still matches")
	assert.Equal(t, 1, nudged)
}

func TestRemoteBoardPollerSendsNoKeyToAnotherURL(t *testing.T) {
	reg := fakeKeyRegistry{keys: map[string]string{"r1": "sekret-key"}}
	for name, urlOf := range map[string]func(string) string{
		"a longer registered URL (the subscription's is its prefix)": func(u string) string { return u + "/other" },
		"a path-only difference":                                     func(u string) string { return u + "x" },
		"the registered URL is a prefix of the subscription's":       func(u string) string { return strings.TrimSuffix(u, u[strings.LastIndex(u, ":"):]) },
	} {
		auth, nudged := pollOnce(t, reg, urlOf)
		assert.Equal(t, []string{""}, auth, name+": no Authorization was sent")
		assert.Zero(t, nudged, name+": the 401 is not an answer")
	}
	auth, _ := pollOnce(t, nil, nil)
	assert.Equal(t, []string{""}, auth, "no key lookup set: none sent, as before")
}

func TestRemoteKeyForSkipsSSHAndUnreadableKeys(t *testing.T) {
	ctx := context.Background()
	reg := fakeKeyRegistry{
		servers: []store.RemoteServer{{ID: "s", URL: "http://h:1", Transport: "ssh"}, {ID: "u", URL: "http://h:2", Transport: "http"}, {ID: "k", URL: "http://h:3", Transport: "http"}},
		keys:    map[string]string{"s": "ssh-key", "k": "good"},
	}
	f := RemoteKeyFor(reg)
	_, ok := f(ctx, "http://h:1")
	assert.False(t, ok, "an ssh server's URL is not an address to send a key to")
	_, ok = f(ctx, "http://h:2")
	assert.False(t, ok, "a key that cannot be read gives none")
	k, ok := f(ctx, "http://h:3/")
	assert.True(t, ok)
	assert.Equal(t, "good", k)
	_, ok = f(ctx, "http://H:3")
	assert.False(t, ok, "the match is exact, host case included")
}
