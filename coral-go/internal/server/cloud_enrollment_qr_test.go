package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

func TestEnrollmentQRLocalHumanLifetimeAndTunnelRefusal(t *testing.T) {
	r := newE2ERemote(t, "enrollment-qr", nil)
	var hubURL string
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if q.URL.Path == "/api/enroll/start" {
			_ = json.NewEncoder(w).Encode(map[string]any{"device_code": strings.Repeat("d", 43), "user_code": "ABCD-EFGH", "verification_url": hubURL + "/enroll?code=ABCD-EFGH", "interval": 30, "expires_in": 600})
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
	}))
	defer hub.Close()
	hubURL = hub.URL
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	m := cloud.New(cloud.Options{HubURL: hub.URL, HTTPClient: hub.Client(), Store: store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.dir)), Now: func() time.Time { return time.Unix(0, clock.Load()) }, MaxMode: func() tunnel.Mode { return tunnel.TierView }})
	r.srv.SetCloud(m)
	r.srv.cloudHandler.SetPeerCheck(func(*http.Request) (bool, bool) { return true, true })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	require.Eventually(t, func() bool { return !m.Status().Loading }, time.Second, time.Millisecond)
	do := func(headers map[string]string, addr string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/cloud/enroll-qr", nil)
		req.Host = "127.0.0.1:8420"
		req.RemoteAddr = addr
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set("Referer", "http://127.0.0.1:8420/")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		r.srv.Router().ServeHTTP(rec, req)
		return rec
	}
	absent := do(nil, "127.0.0.1:1234")
	require.Equal(t, 404, absent.Code)
	m.SetPairingSecret("AAAAAAAAAAAAAAAAAAAAAA")
	require.NoError(t, m.Connect(ctx))
	require.False(t, m.Status().EnrollmentQRExpiresAt.IsZero())
	positive := do(nil, "127.0.0.1:1234")
	require.Equal(t, 200, positive.Code)
	require.Equal(t, "image/png", positive.Header().Get("Content-Type"))
	require.Equal(t, "no-store", positive.Header().Get("Cache-Control"))
	require.Equal(t, "nosniff", positive.Header().Get("X-Content-Type-Options"))
	require.True(t, strings.HasPrefix(positive.Body.String(), "\x89PNG"))
	agentToken, err := r.db.MintSessionToken(ctx, "qr-agent-sid", "qr-agent")
	require.NoError(t, err)
	for i, headers := range []map[string]string{{"Authorization": "Bearer " + r.key()}, {tunnel.ViaHeader: cloud.ViaSecret()}, {store.SessionTokenHeader: agentToken}} {
		rec := do(headers, "127.0.0.1:1234")
		require.Equal(t, 404, rec.Code, "refused caller case %d", i)
		require.Equal(t, absent.Body.String(), rec.Body.String())
	}
	require.NotEqual(t, 200, do(map[string]string{"X-Forwarded-For": "127.0.0.1"}, "127.0.0.1:1234").Code, "a proxy cannot read the QR")
	require.Equal(t, tunnel.Classify("GET", "/api/cloud/enroll-qr", "").String(), "never")
	m.SetPairingSecret("AQEBAQEBAQEBAQEBAQEBAQ")
	require.NoError(t, m.Connect(ctx), "Connect reuses an already pending enrollment")
	replacement := do(nil, "127.0.0.1:1234")
	require.Equal(t, 200, replacement.Code)
	require.NotEqual(t, positive.Body.Bytes(), replacement.Body.Bytes())
	clock.Add(int64(11 * time.Minute))
	require.True(t, m.Status().EnrollmentQRExpiresAt.IsZero())
	require.Equal(t, 404, do(nil, "127.0.0.1:1234").Code)
	clock.Add(-int64(11 * time.Minute))
	m.CancelEnrollment(ctx)
	require.Equal(t, 404, do(nil, "127.0.0.1:1234").Code)
}
