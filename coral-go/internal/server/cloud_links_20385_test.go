package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// stubHub answers the enrollment calls only: a code, then 'not yet' for ever. It counts how often it is asked.
type stubHub struct {
	srv    *httptest.Server
	starts atomic.Int64
}

func newStubHub(t *testing.T) *stubHub {
	t.Helper()
	h := &stubHub{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/enroll/start", func(w http.ResponseWriter, r *http.Request) {
		h.starts.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"device_code": strings.Repeat("d", 43), "user_code": "ABCD-EFGH",
			"verification_url": h.srv.URL + "/enroll?code=ABCD-EFGH", "interval": 2, "expires_in": 600})
	})
	mux.HandleFunc("POST /api/enroll/poll", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		w.Write([]byte(`{"error":"authorization_pending"}`))
	})
	h.srv = httptest.NewServer(mux)
	t.Cleanup(h.srv.Close)
	return h
}

// linkedRemoteWithManager is linkedRemote with a real Manager (it dials nothing: its Hub is not listening).
func linkedRemoteWithManager(t *testing.T) (*e2eRemote, *store.CloudStore, *cloud.Manager, store.CloudLink) {
	t.Helper()
	r, cs, a := linkedRemote(t, &fakeRevoker{})
	m := cloud.New(cloud.Options{HubURL: a.HubOrigin, Store: cs, HTTPClient: http.DefaultClient, LocalBaseURL: "http://127.0.0.1:1", Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Backoff: tunnel.Backoff{Min: time.Hour, Max: time.Hour}, PollInterval: 20 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	require.Eventually(t, func() bool { return !m.Status().Loading }, 5*time.Second, 5*time.Millisecond)
	r.srv.cloudHandler.SetManager(m)
	return r, cs, m, a
}

func TestAddingAHubByAddressShowsTheCodeAndStoresNothing(t *testing.T) {
	r, cs, _, _ := linkedRemoteWithManager(t)
	store.AllowSecondLinkForTest(t)
	hub := newStubHub(t)
	js := map[string]string{"Content-Type": "application/json"}
	h := r.srv.Router()
	rec := call(h, "POST", "/api/cloud/links", `{"hub":"`+hub.srv.URL+`","cap":"interact"}`, js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	body := rec.Body.String()
	assert.Contains(t, body, "ABCD-EFGH")
	assert.NotContains(t, body, strings.Repeat("d", 43), "the device code never leaves Coral")
	assert.Contains(t, body, hub.srv.URL+"/enroll?code=ABCD-EFGH")
	ls, _ := cs.ListLinks(context.Background())
	assert.Len(t, ls, 1, "nothing is stored before the person approves")

	list := call(h, "GET", "/api/cloud/links", "", js)
	require.Equal(t, 200, list.Code)
	assert.Contains(t, list.Body.String(), `"adding"`)
	assert.Contains(t, list.Body.String(), "ABCD-EFGH")

	// Cancel: the pending enrollment is gone.
	c := call(h, "POST", "/api/cloud/links/cancel", `{"hub":"`+hub.srv.URL+`"}`, js)
	require.Equal(t, 200, c.Code, c.Body.String())
	assert.NotContains(t, call(h, "GET", "/api/cloud/links", "", js).Body.String(), "ABCD-EFGH")
}

func TestAddingAHubByAddressRefusals(t *testing.T) {
	r, _, _, a := linkedRemoteWithManager(t)
	store.AllowSecondLinkForTest(t)
	hub := newStubHub(t)
	js := map[string]string{"Content-Type": "application/json"}
	h := r.srv.Router()
	for name, c := range map[string]struct {
		body string
		code int
		say  string
	}{
		"no cap":       {`{"hub":"` + hub.srv.URL + `"}`, 400, "view, interact or launch"},
		"bad cap":      {`{"hub":"` + hub.srv.URL + `","cap":"root"}`, 400, "view, interact or launch"},
		"bad address":  {`{"hub":"http://hub.example.com","cap":"view"}`, 400, "https"},
		"already here": {`{"hub":"` + a.HubOrigin + `","cap":"view"}`, 409, "already linked to that Hub"},
	} {
		rec := call(h, "POST", "/api/cloud/links", c.body, js)
		assert.Equal(t, c.code, rec.Code, "%s: %s", name, rec.Body.String())
		assert.Contains(t, rec.Body.String(), c.say, name)
	}
	assert.Zero(t, hub.starts.Load(), "a refused add never asks the Hub")
}

// Security 1: adding a Hub is the person at this computer's: never through the Hub, and never an agent's token, on either new route.
func TestAddingAHubIsNeverTunneledAndNeverAnAgents(t *testing.T) {
	assert.Equal(t, tunnel.TierNever, tunnel.Classify("POST", "/api/cloud/links", ""))
	assert.Equal(t, tunnel.TierNever, tunnel.Classify("POST", "/api/cloud/links/cancel", ""))
	srv, ts, _ := strictServer(t, true)
	ctx := context.Background()
	agentTok, err := srv.db.MintSessionToken(ctx, "sid-dev-20385", "claude-dev")
	require.NoError(t, err)
	hub := newStubHub(t)
	for _, path := range []string{"/api/cloud/links", "/api/cloud/links/cancel"} {
		req, _ := http.NewRequest("POST", ts.URL+path, strings.NewReader(`{"hub":"`+hub.srv.URL+`","cap":"view"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, agentTok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		assert.Equal(t, http.StatusForbidden, resp.StatusCode, "an agent's token on POST %s", path)
	}
	assert.Zero(t, hub.starts.Load())
	// through the Hub
	r, _, _, _ := linkedRemoteWithManager(t)
	via := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	assert.Equal(t, 403, call(r.srv.Router(), "POST", "/api/cloud/links", `{"hub":"`+hub.srv.URL+`","cap":"view"}`, via).Code)
	assert.Equal(t, 403, call(r.srv.Router(), "POST", "/api/cloud/links/cancel", `{"hub":"`+hub.srv.URL+`"}`, via).Code)
	assert.Zero(t, hub.starts.Load())
}
