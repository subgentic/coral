package routes

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/sshprov"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/hubowner"
	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

type targetResolver struct{ t proxy.Target }

func (r targetResolver) Resolve(context.Context, string) (proxy.Target, error) { return r.t, nil }

// stampWorld is the whole path of #11378 in one process: a HUB (its identity layer and the real remote mount) in front of an ssh -W stream (a fake ssh that joins the stream to a port) in front of a REMOTE
// (its identity layer with the secret file, and the real review handler on a team's for-review artifact). What the person at the hub presses reaches the handler as a person's decision; what a script holding the
// hub's API key sends does not.
type stampWorld struct {
	hub     *httptest.Server
	cookie  *bool // whether the hub sees a signed-in dashboard session
	env     *reviewEnv
	remote  string // the remote's data folder (the secret file is in it)
	secret  string
	hubBody func(path string) string
}

func newStampWorld(t *testing.T, hubSecret, remoteSecret string) *stampWorld {
	t.Helper()
	fakeSSHOnPath(t)

	// the remote: the review handler behind its real identity layer, with the owner secret a human act installed
	env := newReviewEnv(t, false)
	env.tag(t, `["for review"]`)
	rdb, err := storetest.Open(t, filepath.Join(t.TempDir(), "remote.db"))
	require.NoError(t, err)
	t.Cleanup(func() { rdb.Close() })
	remoteDir := t.TempDir()
	ro := NewIdentityObserver(rdb, nil, func(*http.Request) bool { return false })
	ro.SetVerifiers(func(*http.Request) bool { return true }, nil)
	ro.SetHubOwnerDir(remoteDir, time.Now().Add(-time.Hour))
	if remoteSecret != "" {
		require.NoError(t, hubowner.WriteFile(remoteDir, "ssh-box", remoteSecret))
	}
	rr := chi.NewRouter()
	rr.Use(ro.Middleware)
	rr.Post("/api/board/{project}/artifacts/{id}/review", env.h.ReviewArtifact)
	remote := httptest.NewServer(rr)
	t.Cleanup(remote.Close)
	_, portStr, _ := net.SplitHostPort(remote.Listener.Addr().String())
	port := 0
	for _, c := range portStr {
		port = port*10 + int(c-'0')
	}

	// the hub: its own identity layer, the real mount, and the ssh -W stream as the target
	hdb, err := storetest.Open(t, filepath.Join(t.TempDir(), "hub.db"))
	require.NoError(t, err)
	t.Cleanup(func() { hdb.Close() })
	cookie := false
	ho := NewIdentityObserver(hdb, nil, func(*http.Request) bool { return cookie })
	ho.SetVerifiers(func(*http.Request) bool { return true }, nil)
	tg, _ := sshprov.ParseTarget("rich@box.example.com")
	st, err := sshprov.NewStreamTarget(sshprov.Runner{}, tg, port, "the-remotes-api-key-0123456789")
	require.NoError(t, err)
	if hubSecret != "" {
		st.WithOwnerStamp("ssh-box", hubSecret)
	}
	t.Cleanup(st.Close)
	hr := chi.NewRouter()
	hr.Use(ho.Middleware)
	MountRemoteProxy(hr, targetResolver{st})
	hub := httptest.NewServer(hr)
	t.Cleanup(hub.Close)
	return &stampWorld{hub: hub, cookie: &cookie, env: env, remote: remoteDir, secret: remoteSecret}
}

func (w *stampWorld) approve(t *testing.T, mutate func(*http.Request)) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", w.hub.URL+"/api/remote/ssh-box/api/board/alpha/artifacts/"+w.env.id+"/review", strings.NewReader(`{"decision":"approve"}`))
	req.Header.Set("Content-Type", "application/json")
	mutate(req)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	b, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(b, &out)
	return resp.StatusCode, out
}

func (w *stampWorld) approvedMessages(t *testing.T) int { return len(w.env.messages(t)) }

const integrationSecret = "1111111111111111111111111111111111111111111111111111111111111111"

func TestThePersonAtTheHubApprovesThroughTheStreamAndTheRemoteHandlerSeesAPerson(t *testing.T) {
	w := newStampWorld(t, integrationSecret, integrationSecret)
	*w.cookie = true // the signed-in dashboard session of the hub's owner
	code, out := w.approve(t, func(r *http.Request) {})
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "approved", out["state"])
	assert.Equal(t, true, out["changed"])
	assert.Equal(t, 1, w.approvedMessages(t), "the uploader was told once")
}

func TestAScriptWithTheHubsKeyCannotApproveEvenThroughTheSameStream(t *testing.T) {
	w := newStampWorld(t, integrationSecret, integrationSecret)
	code, out := w.approve(t, func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.Equal(t, "owner_only", out["code"], "the handler refused automation: nothing was signed")
	assert.Equal(t, 0, w.approvedMessages(t))
	// and a forged stamp on the same request is no better: the hub drops it and the remote refuses what is left
	code, out = w.approve(t, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
		r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
	})
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.Equal(t, 0, w.approvedMessages(t))
}

func TestWithoutBothHalvesThePersonsDecisionIsRefusedNotApproved(t *testing.T) {
	for name, c := range map[string]struct{ hub, remote string }{
		"the hub holds no secret":          {"", integrationSecret},
		"the computer holds no secret":     {integrationSecret, ""},
		"the two secrets are not the same": {integrationSecret, strings.Repeat("2", 64)},
	} {
		w := newStampWorld(t, c.hub, c.remote)
		*w.cookie = true
		code, out := w.approve(t, func(r *http.Request) {})
		assert.Equal(t, http.StatusForbidden, code, "%s: %v", name, out)
		assert.Equal(t, 0, w.approvedMessages(t), name+": the decision went through")
	}
}
