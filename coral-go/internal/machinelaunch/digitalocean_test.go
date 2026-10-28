package machinelaunch

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9973: the DigitalOcean provider against a stub HTTP server. No test here calls the real API or holds a real token: every provider is pointed at an httptest server by WithBaseURL, and the token
// is a made-up string the tests look for in everything that comes back.

const testToken = "dop_v1_TESTTOKEN0123456789abcdef"

var (
	_ Provider = (*DigitalOcean)(nil)
	_ Lister   = (*DigitalOcean)(nil)
)

type stubAPI struct {
	mu       sync.Mutex
	requests []recorded
	handler  func(w http.ResponseWriter, r *http.Request, body []byte)
}

type recorded struct {
	Method, Path, Query, Auth, ContentType string
	Body                                   []byte
}

func newStub(t *testing.T, h func(w http.ResponseWriter, r *http.Request, body []byte)) (*stubAPI, *DigitalOcean) {
	t.Helper()
	s := &stubAPI{handler: h}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.requests = append(s.requests, recorded{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), b})
		s.mu.Unlock()
		s.handler(w, r, b)
	}))
	t.Cleanup(srv.Close)
	d, err := NewDigitalOcean(testToken, WithBaseURL(srv.URL), WithPollInterval(5*time.Millisecond))
	require.NoError(t, err)
	return s, d
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func TestTheTokenIsCheckedAndNeverShown(t *testing.T) {
	for _, bad := range []string{"", " ", "tok en", "tok\n", "tok\x00", "tök", strings.Repeat("a", 600)} {
		_, err := NewDigitalOcean(bad)
		require.Error(t, err, "%q", bad)
		if len(strings.TrimSpace(bad)) > 3 {
			assert.NotContains(t, err.Error(), bad)
		}
	}
	_, err := NewDigitalOcean(testToken, WithBaseURL("ftp://x"))
	require.Error(t, err, "a base URL that is not http or https")
	d, err := NewDigitalOcean(testToken)
	require.NoError(t, err)
	assert.Equal(t, DigitalOceanAPI, d.baseURL, "the real API is the default; no test sends to it")
	assert.Equal(t, "digitalocean", d.Name())
}

func TestValidateSendsTheBearerTokenAndSaysWhenItIsRefused(t *testing.T) {
	status := http.StatusOK
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeJSON(w, status, map[string]any{"id": "unauthorized", "message": "Unable to authenticate you. Your token was " + testToken})
	})
	require.NoError(t, d.Validate(t.Context()))
	require.Len(t, s.requests, 1)
	assert.Equal(t, "GET", s.requests[0].Method)
	assert.Equal(t, "/account", s.requests[0].Path)
	assert.Equal(t, "Bearer "+testToken, s.requests[0].Auth)

	status = http.StatusUnauthorized
	err := d.Validate(t.Context())
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrUnauthorized)
	assert.NotContains(t, err.Error(), testToken, "a provider that echoes the token back has it removed")
	assert.Contains(t, err.Error(), "[token]")
}

func TestCreateSendsTheSpecAndTheTagAndNothingElse(t *testing.T) {
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		writeJSON(w, http.StatusAccepted, map[string]any{"droplet": map[string]any{"id": 4242, "name": "coral-1", "status": "new", "size_slug": "s-2vcpu-4gb", "region": map[string]any{"slug": "nyc3"}, "tags": []string{"coral-machine", "mine"}}})
	})
	in, err := d.Create(t.Context(), Spec{Name: "coral-1", Region: "nyc3", Size: "s-2vcpu-4gb", Tags: []string{"mine"}, UserData: "#cloud-config\n", SSHKeys: []string{"ab:cd:ef"}})
	require.NoError(t, err)
	assert.Equal(t, Instance{ID: "4242", Name: "coral-1", Status: StatusPending, Region: "nyc3", Size: "s-2vcpu-4gb", Tags: []string{"coral-machine", "mine"}}, in)
	require.Len(t, s.requests, 1)
	r := s.requests[0]
	assert.Equal(t, "POST", r.Method)
	assert.Equal(t, "/droplets", r.Path)
	assert.Equal(t, "application/json", r.ContentType)
	var got map[string]any
	require.NoError(t, json.Unmarshal(r.Body, &got))
	assert.Equal(t, "coral-1", got["name"])
	assert.Equal(t, "nyc3", got["region"])
	assert.Equal(t, "s-2vcpu-4gb", got["size"])
	assert.Equal(t, defaultImage, got["image"], "a stock Ubuntu LTS by default")
	assert.Equal(t, []any{"coral-machine", "mine"}, got["tags"], "the tool's tag first, always")
	assert.Equal(t, []any{"ab:cd:ef"}, got["ssh_keys"])
	assert.Equal(t, "#cloud-config\n", got["user_data"])
	assert.Equal(t, false, got["backups"])
	assert.Equal(t, false, got["ipv6"])
	assert.NotContains(t, string(r.Body), testToken, "the token is a header, never in the body (and so never in the instance's user-data)")
}

func TestCreateRefusesWhatIsNotValidBeforeSendingAnything(t *testing.T) {
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) { writeJSON(w, 202, map[string]any{}) })
	ok := Spec{Name: "coral-1", Region: "nyc3", Size: "s-1vcpu-1gb", UserData: "x"}
	for name, mut := range map[string]func(*Spec){
		"an upper-case name":    func(sp *Spec) { sp.Name = "Coral" },
		"a name with a dot":     func(sp *Spec) { sp.Name = "a.b" },
		"an empty name":         func(sp *Spec) { sp.Name = "" },
		"a region with a space": func(sp *Spec) { sp.Region = "nyc 3" },
		"a size with a slash":   func(sp *Spec) { sp.Size = "s/1" },
		"an image path":         func(sp *Spec) { sp.Image = "../x" },
		"no user-data":          func(sp *Spec) { sp.UserData = "" },
		"huge user-data":        func(sp *Spec) { sp.UserData = strings.Repeat("a", maxUserDataBytes+1) },
		"a bad tag":             func(sp *Spec) { sp.Tags = []string{"a b"} },
		"a bad ssh key":         func(sp *Spec) { sp.SSHKeys = []string{"a b; rm"} },
	} {
		sp := ok
		mut(&sp)
		_, err := d.Create(t.Context(), sp)
		assert.Error(t, err, name)
	}
	assert.Empty(t, s.requests, "nothing reached the provider")
}

func TestWaitRunningPollsUntilActiveWithAnAddress(t *testing.T) {
	calls := 0
	_, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		calls++
		switch {
		case calls == 1:
			writeJSON(w, 200, map[string]any{"droplet": map[string]any{"id": 7, "status": "new"}})
		case calls == 2: // a hiccup the poll rides out
			writeJSON(w, 500, map[string]any{"message": "oops"})
		case calls == 3: // active, but no public address yet
			writeJSON(w, 200, map[string]any{"droplet": map[string]any{"id": 7, "status": "active", "networks": map[string]any{"v4": []map[string]string{{"ip_address": "10.0.0.2", "type": "private"}}}}})
		default:
			writeJSON(w, 200, map[string]any{"droplet": map[string]any{"id": 7, "name": "m", "status": "active", "networks": map[string]any{"v4": []map[string]string{{"ip_address": "10.0.0.2", "type": "private"}, {"ip_address": "203.0.113.9", "type": "public"}}}}})
		}
	})
	in, err := d.WaitRunning(t.Context(), "7")
	require.NoError(t, err)
	assert.Equal(t, StatusRunning, in.Status)
	assert.Equal(t, "203.0.113.9", in.IPv4, "the public address, not the private one")
	assert.Equal(t, 4, calls)
}

func TestWaitRunningStopsOnAnEndStateTheContextAndPersistentFailure(t *testing.T) {
	state := "off"
	_, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		if state == "fail" {
			writeJSON(w, 503, map[string]any{"message": "down"})
			return
		}
		writeJSON(w, 200, map[string]any{"droplet": map[string]any{"id": 7, "status": state}})
	})
	_, err := d.WaitRunning(t.Context(), "7")
	require.Error(t, err, "an off droplet is not going to start")
	state = "mystery"
	_, err = d.WaitRunning(t.Context(), "7")
	require.Error(t, err)
	state = "fail"
	_, err = d.WaitRunning(t.Context(), "7")
	require.Error(t, err, "six answers in a row from a provider that is down: stop")
	var ae *APIError
	require.True(t, errors.As(err, &ae))
	assert.Equal(t, 503, ae.Status)
	state = "new"
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Millisecond)
	defer cancel()
	_, err = d.WaitRunning(ctx, "7")
	assert.ErrorIs(t, err, context.DeadlineExceeded, "the caller's deadline ends the wait")
	_, err = d.WaitRunning(t.Context(), "not-a-number")
	assert.Error(t, err)
}

func TestDeleteSaysWhenTheDropletIsAlreadyGone(t *testing.T) {
	status := 204
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		if status == 204 {
			w.WriteHeader(204)
			return
		}
		writeJSON(w, status, map[string]any{"id": "not_found", "message": "The resource you requested could not be found."})
	})
	require.NoError(t, d.Delete(t.Context(), "55"))
	assert.Equal(t, "DELETE", s.requests[0].Method)
	assert.Equal(t, "/droplets/55", s.requests[0].Path)
	status = 404
	err := d.Delete(t.Context(), "55")
	assert.ErrorIs(t, err, ErrNotFound, "a cleanup ignores an instance that is gone")
	status = 422
	err = d.Delete(t.Context(), "55")
	require.Error(t, err)
	assert.NotErrorIs(t, err, ErrNotFound)
	assert.Error(t, d.Delete(t.Context(), "55; rm -rf /"), "an id is digits")
	assert.Error(t, d.Delete(t.Context(), "../account"))
}

func TestListReturnsOnlyWhatTheToolMadeAcrossPages(t *testing.T) {
	s, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		page := r.URL.Query().Get("page")
		if page == "1" {
			writeJSON(w, 200, map[string]any{"droplets": []map[string]any{{"id": 1, "name": "a", "status": "active", "tags": []string{"coral-machine"}}, {"id": 2, "name": "other", "status": "active", "tags": []string{"x"}}},
				"links": map[string]any{"pages": map[string]any{"next": "https://api/x?page=2"}}})
			return
		}
		writeJSON(w, 200, map[string]any{"droplets": []map[string]any{{"id": 3, "name": "b", "status": "off", "tags": []string{"coral-machine", "mine"}}}})
	})
	got, err := d.List(t.Context())
	require.NoError(t, err)
	require.Len(t, got, 2, "a droplet without the tag is not ours even if the provider sent it")
	assert.Equal(t, "1", got[0].ID)
	assert.Equal(t, "3", got[1].ID)
	assert.Equal(t, StatusStopped, got[1].Status)
	assert.Contains(t, s.requests[0].Query, "tag_name=coral-machine")
	assert.Len(t, s.requests, 2)
}

func TestPriceReadsTheSizeListAndSaysWhenARegionLacksTheSize(t *testing.T) {
	_, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		if r.URL.Query().Get("page") == "1" {
			writeJSON(w, 200, map[string]any{"sizes": []map[string]any{{"slug": "s-1vcpu-1gb", "price_hourly": 0.00893, "price_monthly": 6, "available": true, "regions": []string{"nyc3"}}},
				"links": map[string]any{"pages": map[string]any{"next": "x"}}})
			return
		}
		writeJSON(w, 200, map[string]any{"sizes": []map[string]any{
			{"slug": "s-2vcpu-4gb", "price_hourly": 0.02679, "price_monthly": 24, "available": true, "regions": []string{"nyc3", "sfo3"}},
			{"slug": "s-8vcpu-16gb", "price_hourly": 0.1, "price_monthly": 96, "available": false, "regions": []string{"nyc3"}}}})
	})
	p, err := d.Price(t.Context(), "nyc3", "s-2vcpu-4gb")
	require.NoError(t, err)
	assert.Equal(t, Price{HourlyUSD: 0.02679, MonthlyUSD: 24}, p, "found on the second page")
	_, err = d.Price(t.Context(), "ams3", "s-2vcpu-4gb")
	assert.ErrorIs(t, err, ErrNotFound, "not offered in that region")
	_, err = d.Price(t.Context(), "nyc3", "s-8vcpu-16gb")
	assert.ErrorIs(t, err, ErrNotFound, "not available")
	_, err = d.Price(t.Context(), "nyc3", "no-such")
	assert.ErrorIs(t, err, ErrNotFound)
	_, err = d.Price(t.Context(), "nyc 3", "x")
	assert.Error(t, err)
}

func TestARedirectIsNeverFollowedSoTheTokenGoesToOneHost(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the redirect was followed: %s with %q", r.URL.Path, r.Header.Get("Authorization"))
	}))
	defer other.Close()
	_, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		http.Redirect(w, r, other.URL+"/steal", http.StatusFound)
	})
	err := d.Validate(t.Context())
	require.Error(t, err)
	var ae *APIError
	require.True(t, errors.As(err, &ae))
	assert.Equal(t, http.StatusFound, ae.Status)
}

func TestAnAnswerIsBoundedAndAMalformedOneIsRefused(t *testing.T) {
	big := true
	_, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		if big {
			_, _ = w.Write([]byte(`{"droplet":{"name":"` + strings.Repeat("a", maxResponseBytes) + `"}}`))
			return
		}
		_, _ = w.Write([]byte(`not json`))
	})
	_, err := d.get(t.Context(), "1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "larger than")
	big = false
	_, err = d.get(t.Context(), "1")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "not json", "what the provider sent is not echoed")
}

func TestErrorMessagesAreCleanedAndTheTokenIsRemovedFromEveryOne(t *testing.T) {
	_, d := newStub(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		writeJSON(w, 422, map[string]any{"id": "unprocessable", "message": "bad\x1b[31m request " + testToken + " \u202e " + strings.Repeat("x", 500)})
	})
	err := d.Delete(t.Context(), "5")
	require.Error(t, err)
	msg := err.Error()
	assert.NotContains(t, msg, testToken)
	assert.NotContains(t, msg, "\x1b")
	assert.NotContains(t, msg, "\u202e")
	assert.LessOrEqual(t, len(msg), 320, "a provider message is cut")
	// a connection that fails names no token either
	d2, _ := NewDigitalOcean(testToken, WithBaseURL("http://127.0.0.1:1"))
	err = d2.Validate(t.Context())
	require.Error(t, err)
	assert.NotContains(t, err.Error(), testToken)
}
