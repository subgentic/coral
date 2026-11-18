package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Slice 4: `coral cloud connect` makes the pairing secret, puts it in the link it prints (#p=), and hands it to this Coral in the body of POST /api/cloud/connect. The route is local only, so the Hub can never set one. The secret is kept in memory,
// answered nowhere, and a malformed one is a 400 that does not echo it.
func TestConnectTakesThePairingSecretAndNeverShowsIt(t *testing.T) {
	r := newE2ERemote(t, "connect-pairing-secret", nil)
	h := r.srv.Router()
	r.srv.cloudHandler.SetPeerCheck(func(*http.Request) (bool, bool) { return true, true })
	dash := map[string]string{"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:8420"}
	m := cloud.New(cloud.Options{HubURL: "https://hub.example.invalid", Store: store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.dir)), MaxMode: func() tunnel.Mode { return tunnel.TierView }})
	r.srv.SetCloud(m)
	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr, req.Host = "127.0.0.1:50000", "127.0.0.1:8420"
		req.Header.Set("Content-Type", "application/json")
		for k, v := range dash {
			req.Header.Set(k, v)
		}
		ctx, cancel := context.WithTimeout(req.Context(), 50*time.Millisecond) // a connector never run waits for its enrollment; the secret is taken before that
		t.Cleanup(cancel)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req.WithContext(ctx))
		return rec
	}
	secret := devicekey.NewPairingSecret()

	for name, body := range map[string]string{
		"too short":               `{"pairing_secret":"abc"}`,
		"not base64url":           `{"pairing_secret":"` + strings.Repeat("!", 22) + `"}`,
		"wrong type":              `{"pairing_secret":5}`,
		"valid secret, bad mode":  `{"pairing_secret":"` + secret + `","mode":"admin"}`,
		"valid secret, extra key": `{"pairing_secret":"` + secret + `","x":1}`,
	} {
		rec := do("POST", "/api/cloud/connect", body)
		assert.Equal(t, http.StatusBadRequest, rec.Code, name)
		assert.NotContains(t, rec.Body.String(), secret, name)
		assert.False(t, m.PairingSecretHeld(), name+": nothing was kept")
	}
	rec := do("POST", "/api/cloud/connect", `{"pairing_secret":"`+secret+`"}`)
	assert.NotContains(t, rec.Body.String(), secret, "the answer never carries it")
	assert.True(t, m.PairingSecretHeld())
	st := do("GET", "/api/cloud/status", "")
	assert.NotContains(t, st.Body.String(), secret, "status")
}
