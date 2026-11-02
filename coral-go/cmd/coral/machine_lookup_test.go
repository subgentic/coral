package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The lookup's answer must be ONE public address and nothing else (Security's ruling, #9934).
func TestParsePublicLookupAnswer(t *testing.T) {
	for in, want := range map[string]string{
		"8.8.8.8":                 "8.8.8.8",
		" 8.8.8.8\n":              "8.8.8.8",
		"2606:4700:4700::1111":    "2606:4700:4700::1111",
		"::ffff:8.8.8.8":          "8.8.8.8",
		"2606:4700:4700:0::1111 ": "2606:4700:4700::1111",
	} {
		got, err := parsePublicLookupAnswer(in)
		if err != nil || got != want {
			t.Errorf("%q: got %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{
		"", "garbage", "8.8.8.8/32", "8.8.8.0/24", "8.8.8.8:443", "8.8.8.8 8.8.4.4", "8.8.8.8\n8.8.4.4", "<html>8.8.8.8</html>", "[2606:4700:4700::1111]",
		"0.0.0.0", "::", "10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "::1", "169.254.169.254", "fe80::1", "fe80::1%eth0", "224.0.0.1", "ff02::1", "255.255.255.255",
		"100.64.0.1", "192.0.2.1", "198.51.100.7", "203.0.113.5", "198.18.0.1", "240.0.0.1", "fc00::1", "fd12:3456::1", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
		"1.2.3", "256.1.1.1", "0x08.8.8.8", "08.8.8.8",
	} {
		if got, err := parsePublicLookupAnswer(in); err == nil {
			t.Errorf("%q was accepted as %q", in, got)
		}
	}
}

func lookupServer(t *testing.T, h http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	oldE, oldC, oldT := publicIPEndpoint, lookupClient, lookupTimeout
	publicIPEndpoint = srv.URL
	c := srv.Client()
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	lookupClient = c
	t.Cleanup(func() { publicIPEndpoint, lookupClient, lookupTimeout = oldE, oldC, oldT })
}

func TestDetectSSHSource(t *testing.T) {
	good := func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("8.8.4.4\n")) }
	lookupServer(t, good)
	if got, err := detectSSHSource(t.Context()); err != nil || got != "8.8.4.4" {
		t.Fatalf("got %q, %v", got, err)
	}
	for name, h := range map[string]http.HandlerFunc{
		"cidr":     func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("8.8.4.0/24")) },
		"private":  func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("10.1.2.3")) },
		"open":     func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("0.0.0.0")) },
		"garbage":  func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("not an address")) },
		"oversize": func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("8.8.4.4" + strings.Repeat(" ", 200))) },
		"500":      func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500); w.Write([]byte("8.8.4.4")) },
		"redirect": func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "http://8.8.4.4/", http.StatusFound) },
		"timeout": func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(500 * time.Millisecond)
			w.Write([]byte("8.8.4.4"))
		},
	} {
		lookupServer(t, h)
		lookupTimeout = 100 * time.Millisecond
		got, err := detectSSHSource(t.Context())
		if err == nil || !strings.Contains(err.Error(), "--allow-ssh-from") {
			t.Errorf("%s: got %q, %v: want a refusal that says to pass --allow-ssh-from", name, got, err)
		}
	}
	// a lookup that is not https is refused before any request is made
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.Write([]byte("8.8.4.4")) }))
	defer srv.Close()
	old := publicIPEndpoint
	publicIPEndpoint = srv.URL
	defer func() { publicIPEndpoint = old }()
	if _, err := detectSSHSource(t.Context()); err == nil || called {
		t.Fatalf("a plain http lookup was made or accepted: %v, called %v", err, called)
	}
}
