package machinelaunch

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

const goodKey = "chk_abcdefgh12345678"

func hubServer(t *testing.T, handler http.HandlerFunc) (*HubClient, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &HubClient{BaseURL: srv.URL, Key: goodKey}, srv
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
	want := map[string]any{"adapter": "generic", "label": "coral-1", "persistence": "ephemeral", "ttl_minutes": float64(5)}
	if _, has := got["accept_terms"]; has {
		t.Error("accept_terms is not sent: the key accepted the terms when it was made")
	}
	if _, has := got["provider_scope"]; has {
		t.Error("provider_scope is for aws and gcp: the Hub answers a generic mint that has it with a 400")
	}
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
		{409, `{"error":"terms_reconsent_required"}`, "create a new automation key in Coral Hub (browser, fresh sign-in) and save it again"},
		{429, `{"error":"rate_limited"}`, "too many credentials"},
		{409, `{"error":"live_limit_reached"}`, "as many machine credentials outstanding as it may"},
		{409, `{"error":"adapter_capacity_reached"}`, "this is not retried"},
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

const (
	testCredID  = "123e4567-e89b-12d3-a456-426614174000"
	testDestroy = "chd_destroycredential0123456789"
)

// mintAnswer is the Hub's mint answer: the credential and its id, never a destroy credential (that belongs to the automation key).
const mintAnswer = `{"credential":"chb_0123456789abcdef","credential_id":"` + testCredID + `","adapter":"generic","persistence":"ephemeral"}`

// Revoke (the shape is coral-hub's description of the route, assumed until Lead's HubRevoker): POST /api/bootstrap/credentials/{id}/revoke with the destroy credential as the one Bearer header, no body, no Origin.
func TestRevokeSendsTheDestroyCredentialAndNothingElse(t *testing.T) {
	var method, path, auth, origin, cookie string
	var bodyLen int64
	var calls int
	h, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/bootstrap/credentials" {
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(mintAnswer))
			return
		}
		calls++
		method, path, auth, origin, cookie, bodyLen = r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Origin"), r.Header.Get("Cookie"), r.ContentLength
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	h.DestroyKey = testDestroy
	if _, err := h.Mint(context.Background(), "coral-1"); err != nil {
		t.Fatal(err)
	}
	if err := h.Revoke(context.Background(), "coral-1"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if method != "POST" || path != "/api/bootstrap/credentials/"+testCredID+"/revoke" || auth != "Bearer "+testDestroy || origin != "" || cookie != "" || bodyLen > 0 || calls != 1 {
		t.Fatalf("request: %s %s auth %q origin %q cookie %q body %d calls %d", method, path, auth, origin, cookie, bodyLen, calls)
	}
	if strings.Contains(auth, goodKey) {
		t.Fatal("the automation key must not be what revokes")
	}
}

func TestRevokeWithNothingMintedOrNoIdOrNoDestroyKeyIsRefusedLocally(t *testing.T) {
	var hits int
	h, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/bootstrap/credentials" {
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"credential":"chb_0123456789abcdef"}`)) // a Hub that sends no credential id
			return
		}
		hits++
	})
	if err := h.Revoke(context.Background(), "never-minted"); !errors.Is(err, ErrNoDestroyKey) {
		t.Fatalf("no destroy key: %v", err)
	}
	h.DestroyKey = testDestroy
	if err := h.Revoke(context.Background(), "never-minted"); !errors.Is(err, ErrNothingToRevoke) {
		t.Fatalf("nothing minted: %v", err)
	}
	if _, err := h.Mint(context.Background(), "coral-1"); err != nil {
		t.Fatal(err)
	}
	if err := h.Revoke(context.Background(), "coral-1"); !errors.Is(err, ErrNothingToRevoke) || hits != 0 {
		t.Fatalf("no id: %v, hits %d", err, hits)
	}
	h.DestroyKey = "chk_notadestroykey0123456789" // the automation key is not the destroy credential
	if err := h.Revoke(context.Background(), "coral-1"); !errors.Is(err, ErrNoDestroyKey) || hits != 0 {
		t.Fatalf("a chk_ is not a chd_: %v, hits %d", err, hits)
	}
}

func TestRevokeRetriesWhatMayPassAndSaysTheStatusOfAnythingElse(t *testing.T) {
	cases := []struct {
		name     string
		statuses []int
		wantKind RevokeKind
		wantOK   bool
		calls    int
	}{
		{"idempotent: ok straight away", []int{200}, 0, true, 1},
		{"429 then 200", []int{429, 200}, 0, true, 2},
		{"503 twice then 200", []int{503, 503, 200}, 0, true, 3},
		{"429 for good", []int{429}, RevokeRateLimited, false, 5},
		{"404 is not retried", []int{404}, RevokeNotFound, false, 1},
		{"401 is not retried", []int{401}, RevokeUnauthorized, false, 1},
	}
	for _, c := range cases {
		var calls int
		h, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/bootstrap/credentials" {
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(mintAnswer))
				return
			}
			st := c.statuses[min(calls, len(c.statuses)-1)]
			calls++
			w.WriteHeader(st)
			_, _ = w.Write([]byte(`{"error":"x chd_leak ` + testDestroy + `"}`))
		})
		h.DestroyKey = testDestroy
		h.RevokeSleep = func(context.Context, time.Duration) error { return nil } // no waiting in a test
		_, _ = h.Mint(context.Background(), "coral-1")
		err := h.Revoke(context.Background(), "coral-1")
		var re *IdentityRevokeError
		switch {
		case c.wantOK:
			if err != nil {
				t.Errorf("%s: %v", c.name, err)
			}
		case !errors.As(err, &re) || re.Kind != c.wantKind:
			t.Errorf("%s: err %v", c.name, err)
		}
		if calls != c.calls {
			t.Errorf("%s: %d calls, want %d", c.name, calls, c.calls)
		}
		if err != nil && (strings.Contains(err.Error(), testDestroy) || strings.Contains(err.Error(), "chd_")) {
			t.Errorf("%s: the error holds the destroy credential: %v", c.name, err)
		}
	}
}

// The mint answer's expires_at is kept, and ExpiresAt gives it: a failed launch says when the credential stops working from the Hub's own word.
func TestMintKeepsTheHubsExpiryAndAnswerWithoutOneSaysNothingGuessed(t *testing.T) {
	var withExpiry bool
	h, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		if withExpiry {
			_, _ = w.Write([]byte(`{"credential":"chb_0123456789abcdef","credential_id":"` + testCredID + `","expires_at":"2026-10-29T10:05:30Z"}`))
			return
		}
		_, _ = w.Write([]byte(`{"credential":"chb_0123456789abcdef","credential_id":"` + testCredID + `"}`))
	})
	withExpiry = true
	_, _ = h.Mint(context.Background(), "coral-1")
	if at, ok := h.ExpiresAt("coral-1"); !ok || at.UTC().Format(time.RFC3339) != "2026-10-29T10:05:30Z" {
		t.Fatalf("expiry: %v %v", at, ok)
	}
	withExpiry = false
	_, _ = h.Mint(context.Background(), "coral-2")
	if _, ok := h.ExpiresAt("coral-2"); ok {
		t.Fatal("an answer with no expires_at has no expiry")
	}
	if _, ok := h.ExpiresAt("never"); ok {
		t.Fatal("nothing minted has none")
	}
}

// #12588 (coral-hub's contract): before anything is created at the provider the launch asks GET /api/bootstrap/ready, with no Authorization, and goes on only for a 200 with a JSON content type and
// the exact body {"ready":true}. Everything else refuses: the route is not mounted (404, today's answer), a CSRF or login refusal (403), a method refusal, a sign-in page, a redirect, HTML, another body,
// a Hub that cannot be reached. A keyless POST to the credentials route was the first probe; it hits the Hub's CSRF check and answers 403, so it refused every launch.
func TestPreflightGoesOnOnlyForTheReadyAnswer(t *testing.T) {
	var methods, paths, auths []string
	type answer struct {
		status int
		ctype  string
		body   string
	}
	ans := answer{http.StatusOK, "application/json", `{"ready":true}`}
	h, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) {
		methods, paths, auths = append(methods, r.Method), append(paths, r.URL.Path), append(auths, r.Header.Get("Authorization"))
		if ans.ctype != "" {
			w.Header().Set("Content-Type", ans.ctype)
		}
		w.WriteHeader(ans.status)
		_, _ = w.Write([]byte(ans.body))
	})

	// the one passing case (and the same with the charset parameter and a trailing newline a JSON writer adds)
	for _, ok := range []answer{{http.StatusOK, "application/json", `{"ready":true}`}, {http.StatusOK, "application/json; charset=utf-8", "{\"ready\":true}\n"}} {
		ans = ok
		if err := h.Preflight(context.Background()); err != nil {
			t.Fatalf("%+v: %v", ok, err)
		}
	}

	// not served: said as such, with the status and host and no key
	for _, st := range []int{http.StatusNotFound, http.StatusNotImplemented} {
		ans = answer{st, "text/plain; charset=utf-8", "404 page not found\n"}
		err := h.Preflight(context.Background())
		if !errors.Is(err, ErrHubBootstrapOff) || errors.Is(err, ErrHubUnrecognised) {
			t.Fatalf("%d: want ErrHubBootstrapOff, got %v", st, err)
		}
		if !strings.Contains(err.Error(), "HTTP "+strconv.Itoa(st)) || !strings.Contains(err.Error(), "127.0.0.1") || strings.Contains(err.Error(), goodKey) {
			t.Fatalf("%d: the refusal names the status and the host and not the key: %v", st, err)
		}
	}
	// every other answer refuses too
	for name, c := range map[string]answer{
		"403 CSRF":                 {http.StatusForbidden, "application/json", `{"error":"forbidden"}`},
		"405":                      {http.StatusMethodNotAllowed, "", ""},
		"401":                      {http.StatusUnauthorized, "application/json", `{"error":"unauthorized"}`},
		"429":                      {http.StatusTooManyRequests, "", ""},
		"500":                      {http.StatusInternalServerError, "", ""},
		"503":                      {http.StatusServiceUnavailable, "", ""},
		"a redirect":               {http.StatusFound, "", ""},
		"a sign-in page":           {http.StatusOK, "text/html; charset=utf-8", "<html>Sign in</html>"},
		"HTML where JSON is due":   {http.StatusOK, "text/html", `{"ready":true}`},
		"no content type":          {http.StatusOK, "", `{"ready":true}`},
		"ready false":              {http.StatusOK, "application/json", `{"ready":false}`},
		"another body":             {http.StatusOK, "application/json", `{"ready":true,"extra":1}`},
		"ready as a string":        {http.StatusOK, "application/json", `{"ready":"true"}`},
		"an empty 200":             {http.StatusOK, "application/json", ""},
		"a 204":                    {http.StatusNoContent, "application/json", ""},
		"text/plain with the body": {http.StatusOK, "text/plain", `{"ready":true}`},
		"a body past the limit":    {http.StatusOK, "application/json", `{"ready":true}` + strings.Repeat(" ", int(maxHubAnswer)+10)},
	} {
		ans = c
		err := h.Preflight(context.Background())
		if !errors.Is(err, ErrHubUnrecognised) || errors.Is(err, ErrHubBootstrapOff) {
			t.Errorf("%s: only the ready answer goes on: %v", name, err)
		}
	}
	for i := range methods {
		if methods[i] != http.MethodGet || paths[i] != "/api/bootstrap/ready" || auths[i] != "" {
			t.Errorf("probe %d: %s %s auth %q: a GET of /api/bootstrap/ready with no Authorization", i, methods[i], paths[i], auths[i])
		}
	}

	// a redirect is not followed (the answer is the redirect itself): a Hub that sends the probe elsewhere is not 'ready'
	var followed bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		followed = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ready":true}`))
	}))
	defer other.Close()
	redirecting, _ := hubServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/ready", http.StatusFound)
	})
	if err := redirecting.Preflight(context.Background()); !errors.Is(err, ErrHubUnrecognised) || followed {
		t.Errorf("a redirect must not be followed (followed=%v): %v", followed, err)
	}

	// an unreachable Hub refuses too, without the transport error's text (it may hold the address)
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	err := (&HubClient{BaseURL: url, Key: goodKey}).Preflight(context.Background())
	if !errors.Is(err, ErrHubUnrecognised) || !strings.Contains(err.Error(), "could not reach") {
		t.Errorf("an unreachable Hub: %v", err)
	}

	// a key or an address that can never work is refused first, before the Hub is asked at all
	asked := false
	local := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { asked = true }))
	defer local.Close()
	if err := (&HubClient{BaseURL: local.URL, Key: "not-a-key"}).Preflight(context.Background()); err == nil || !strings.Contains(err.Error(), "does not look like one") || asked {
		t.Errorf("a malformed key (asked=%v): %v", asked, err)
	}
	if err := (&HubClient{BaseURL: "http://example.com", Key: goodKey}).Preflight(context.Background()); err == nil || !strings.Contains(err.Error(), "must be https") {
		t.Errorf("a plain http Hub: %v", err)
	}
}
