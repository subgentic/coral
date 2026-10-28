package machinelaunch

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const goodKey = "chk_abcdefgh12345678"

func hubServer(t *testing.T, handler http.HandlerFunc) (*HubClient, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &HubClient{BaseURL: srv.URL, Key: goodKey, TermsVersion: "2.0.2"}, srv
}

func TestMintSendsTheNotesRequestAndReturnsTheCredential(t *testing.T) {
	var got map[string]any
	var auth, ctype, method, path string
	h, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) {
		auth, ctype, method, path = r.Header.Get("Authorization"), r.Header.Get("Content-Type"), r.Method, r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"credential":"chb_0123456789abcdef"}`))
	})
	cred, err := h.Mint(context.Background(), "coral-1")
	if err != nil || cred != "chb_0123456789abcdef" {
		t.Fatalf("got %q, %v", cred, err)
	}
	if method != "POST" || path != "/api/bootstrap/credentials" || auth != "Bearer "+goodKey || ctype != "application/json" {
		t.Fatalf("request: %s %s %q %q", method, path, auth, ctype)
	}
	want := map[string]any{"adapter": "generic", "provider_scope": "digitalocean", "label": "coral-1", "persistence": "ephemeral", "ttl_minutes": float64(5), "accept_terms": "2.0.2"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	if len(got) != len(want) {
		t.Errorf("extra fields in the request: %v", got)
	}
}

func TestMintSaysRefusalsInItsOwnWordsAndNeverLeaksTheKey(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{401, `{"error":"bad key chk_abcdefgh12345678"}`, "did not accept the key"},
		{403, `{}`, "did not accept the key"},
		{409, `{"error":"terms_reconsent_required"}`, "terms accepted again"},
		{429, `{"error":"rate_limited"}`, "too many credentials"},
		{500, `{"error":"boom"}`, "HTTP 500, boom"},
		{500, `{"error":"Contains SPACES and chk_abcdefgh12345678"}`, "HTTP 500)"},
	}
	for _, c := range cases {
		h, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(c.status); _, _ = w.Write([]byte(c.body)) })
		_, err := h.Mint(context.Background(), "coral-1")
		var he *HubError
		if err == nil || !errors.As(err, &he) || he.Status != c.status || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%d %s: %v", c.status, c.body, err)
			continue
		}
		if strings.Contains(err.Error(), "abcdefgh") || strings.Contains(err.Error(), "SPACES") {
			t.Errorf("the error holds the key or the body: %v", err)
		}
	}
}

func TestMintRefusesABadAnswerKeyLabelAndAddress(t *testing.T) {
	h, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"credential":"not-a-credential"}`))
	})
	if _, err := h.Mint(context.Background(), "coral-1"); err == nil || !strings.Contains(err.Error(), "did not carry") {
		t.Errorf("a bad credential shape: %v", err)
	}
	if _, err := (&HubClient{BaseURL: "https://app.coralhub.dev", Key: "wrong"}).Mint(context.Background(), "x"); err == nil || strings.Contains(err.Error(), "wrong") {
		t.Errorf("a bad key shape: %v", err)
	}
	for _, label := range []string{"", "-a", "A", "has space", strings.Repeat("a", 64)} {
		if _, err := h.Mint(context.Background(), label); err == nil {
			t.Errorf("label %q accepted", label)
		}
	}
	for _, base := range []string{"http://app.coralhub.dev", "https://user:pw@app.coralhub.dev", "https://app.coralhub.dev/path", "https://app.coralhub.dev?x=1", "ftp://a", ""} {
		if _, err := (&HubClient{BaseURL: base, Key: goodKey}).Mint(context.Background(), "coral-1"); err == nil {
			t.Errorf("address %q accepted", base)
		}
	}
}

func TestMintFollowsNoRedirectAndDropsTransportDetail(t *testing.T) {
	var hits int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer other.Close()
	h, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	})
	_, err := h.Mint(context.Background(), "coral-1")
	var he *HubError
	if !errors.As(err, &he) || he.Status != http.StatusTemporaryRedirect || hits != 0 {
		t.Fatalf("a redirect must be an error and the key must not travel on: %v, hits %d", err, hits)
	}
	down := &HubClient{BaseURL: "http://127.0.0.1:1", Key: goodKey}
	if _, err := down.Mint(context.Background(), "coral-1"); err == nil || strings.Contains(err.Error(), "127.0.0.1") || !strings.Contains(err.Error(), "could not reach") {
		t.Fatalf("an unreachable Hub: %v", err)
	}
}
