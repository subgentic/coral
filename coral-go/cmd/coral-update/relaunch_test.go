package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func relaunchServer(t *testing.T, status string, postCode int) (*httptest.Server, *atomic.Int32, *atomic.Value) {
	var posts atomic.Int32
	var body atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/system/update":
			io.WriteString(w, status)
		case r.Method == http.MethodPost && r.URL.Path == "/api/system/update/relaunch-local":
			posts.Add(1)
			b, _ := io.ReadAll(r.Body)
			body.Store(string(b))
			w.WriteHeader(postCode)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &posts, &body
}

func relaunchRun(t *testing.T, srv *httptest.Server, inside bool, args ...string) (relaunchOut, int) {
	var out bytes.Buffer
	code := runRelaunch(args, relaunchEnv{insideAgent: func() bool { return inside }, transport: func() http.RoundTripper { return http.DefaultTransport }, base: srv.URL}, &out)
	var o relaunchOut
	if err := json.Unmarshal(out.Bytes(), &o); err != nil {
		t.Fatalf("output %q: %v", out.String(), err)
	}
	return o, code
}

const readyStatus = `{"relaunch":{"available":true,"reason":"","ack":"tok.123","restarts":[{"name":"a"},{"name":"b"}]}}`

func TestRelaunchSendsTheAckFromTheStatus(t *testing.T) {
	srv, posts, body := relaunchServer(t, readyStatus, http.StatusAccepted)
	o, code := relaunchRun(t, srv, false)
	if o.Result != "relaunched" || code != 0 || posts.Load() != 1 {
		t.Fatalf("%+v %d posts=%d", o, code, posts.Load())
	}
	if body.Load().(string) != `{"ack":"tok.123"}` {
		t.Fatalf("body %v", body.Load())
	}
}

func TestRelaunchCheckCountsAgentsAndSendsNothing(t *testing.T) {
	srv, posts, _ := relaunchServer(t, readyStatus, http.StatusAccepted)
	o, code := relaunchRun(t, srv, false, "--check")
	if o.Result != "ready" || o.Agents != 2 || code != 0 || posts.Load() != 0 {
		t.Fatalf("%+v %d posts=%d", o, code, posts.Load())
	}
}

func TestRelaunchSendsNothingWhenNotReady(t *testing.T) {
	for _, reason := range []string{"local_approval_needed", "unsupported_install", "nothing_staged", "Some free text <b>"} {
		status := `{"relaunch":{"available":false,"reason":` + jsonString(reason) + `,"ack":"x"}}`
		srv, posts, _ := relaunchServer(t, status, http.StatusAccepted)
		o, code := relaunchRun(t, srv, false)
		if o.Result != "not_ready" || code == 0 || posts.Load() != 0 {
			t.Fatalf("%s: %+v %d posts=%d", reason, o, code, posts.Load())
		}
		if strings.ContainsAny(o.Reason, " <>") {
			t.Fatalf("remote text was printed: %q", o.Reason)
		}
	}
	// available but no token: also nothing
	srv, posts, _ := relaunchServer(t, `{"relaunch":{"available":true,"ack":""}}`, http.StatusAccepted)
	if o, _ := relaunchRun(t, srv, false); o.Result != "not_ready" || posts.Load() != 0 {
		t.Fatalf("%+v", o)
	}
}

// An agent's session never reaches the network: the command is for the person at this computer.
func TestRelaunchRefusesInsideAnAgentSession(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer srv.Close()
	for _, args := range [][]string{nil, {"--check"}} {
		o, code := relaunchRun(t, srv, true, args...)
		if o.Result != "refused" || o.Reason != "agent_session" || code == 0 {
			t.Fatalf("%+v %d", o, code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("an agent session reached the server")
	}
}

func TestRelaunchServerRefusalIsAFixedWord(t *testing.T) {
	srv, _, _ := relaunchServer(t, readyStatus, http.StatusForbidden)
	if o, code := relaunchRun(t, srv, false); o.Result != "refused" || o.Reason != "server_refused" || code == 0 {
		t.Fatalf("%+v %d", o, code)
	}
	srv2, _, _ := relaunchServer(t, readyStatus, http.StatusInternalServerError)
	if o, _ := relaunchRun(t, srv2, false); o.Result != "failed" {
		t.Fatalf("%+v", o)
	}
}

func TestRelaunchUsage(t *testing.T) {
	srv, posts, _ := relaunchServer(t, readyStatus, http.StatusAccepted)
	if o, code := relaunchRun(t, srv, false, "--now", "x"); o.Result != "failed" || code != 2 || posts.Load() != 0 {
		t.Fatalf("%+v %d", o, code)
	}
}

func jsonString(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestRelaunchArgs(t *testing.T) {
	for args, want := range map[string]bool{"": true, "--check": true, "--port 8451": true, "--check --port 8451": true, "--port 0": false, "--port 70000": false, "--port 08451": false, "--port": false, "--port x": false, "--check --check": false, "--url http://x": false} {
		var a []string
		if args != "" {
			a = strings.Fields(args)
		}
		if _, _, ok := relaunchArgs(a); ok != want {
			t.Errorf("%q: ok=%v", args, ok)
		}
	}
}
