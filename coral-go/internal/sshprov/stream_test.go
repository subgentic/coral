package sshprov

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"

	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

// TestHelperSSHW is the fake `ssh -W host:port`: the test binary run as ssh. It joins its stdin and stdout to the address -W names, as ssh would over the channel.
func TestHelperSSHW(t *testing.T) {
	if os.Getenv("SSHPROV_FAKE_SSH") != "1" && !strings.Contains(strings.Join(os.Args, " "), "-W") {
		t.Skip("helper process")
	}
	var addr string
	for i, a := range os.Args {
		if a == "-W" && i+1 < len(os.Args) {
			addr = os.Args[i+1]
		}
	}
	c, err := net.Dial("tcp", addr)
	if err != nil {
		os.Exit(255)
	}
	go io.Copy(c, os.Stdin)
	io.Copy(os.Stdout, c)
	os.Exit(0)
}

// fakeSSHW is a script that logs its argv and runs the helper above.
func fakeSSHW(t *testing.T) (ssh, log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "argv")
	ssh = filepath.Join(dir, "ssh")
	script := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> '" + log + "'; done\nexec '" + os.Args[0] + "' -test.run=TestHelperSSHW -- \"$@\"\n"
	if err := os.WriteFile(ssh, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return ssh, log
}

func portOf(t *testing.T, ts *httptest.Server) int {
	u, _ := url.Parse(ts.URL)
	_, p, _ := net.SplitHostPort(u.Host)
	n := 0
	for _, c := range p {
		n = n*10 + int(c-'0')
	}
	return n
}

const streamKey = "remote-api-key-123"

func TestStreamTargetReachesTheRemoteOverSSHWAndSendsTheKeyOnlyAsABearer(t *testing.T) {
	var mu sync.Mutex
	var seen http.Header
	var seenPath, seenHost string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen, seenPath, seenHost = r.Header.Clone(), r.URL.Path, r.Host
		mu.Unlock()
		io.WriteString(w, `{"status":"ok"}`)
	}))
	defer remote.Close()
	ssh, log := fakeSSHW(t)
	tg, _ := ParseTarget("rich@box.example.com:2222")
	st, err := NewStreamTarget(Runner{SSH: ssh}, tg, portOf(t, remote), streamKey)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	req, _ := http.NewRequest("GET", "http://x.invalid/api/health", nil)
	resp, err := st.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != `{"status":"ok"}` {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
	mu.Lock()
	defer mu.Unlock()
	if seenHost != "127.0.0.1:"+strconv.Itoa(portOf(t, remote)) {
		t.Errorf("the remote saw Host %q; its own Host check accepts only its loopback address", seenHost)
	}
	if seen.Get("Authorization") != "Bearer "+streamKey || seenPath != "/api/health" {
		t.Errorf("remote saw %v %q", seen, seenPath)
	}
	b, _ := os.ReadFile(log)
	argv := string(b)
	if strings.Contains(argv, streamKey) {
		t.Errorf("the key is in argv:\n%s", argv)
	}
	for _, want := range []string{"-W\n127.0.0.1:", "StrictHostKeyChecking=yes", "-p\n2222\n", "--\nrich@box.example.com\n"} {
		if !strings.Contains(argv, want) {
			t.Errorf("argv lacks %q:\n%s", want, argv)
		}
	}
	for _, bad := range []string{"-L\n", "-R\n", "-D\n", "StrictHostKeyChecking=no", "accept-new"} {
		if strings.Contains(argv, bad) {
			t.Errorf("argv has %q:\n%s", bad, argv)
		}
	}
}

func TestHubProxyTreatsAStreamTargetAsADirectKeyTarget(t *testing.T) {
	var mu sync.Mutex
	var seen http.Header
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = r.Header.Clone()
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{}`)
	}))
	defer remote.Close()
	ssh, _ := fakeSSHW(t)
	tg, _ := ParseTarget("rich@box.example.com")
	st, _ := NewStreamTarget(Runner{SSH: ssh}, tg, portOf(t, remote), streamKey)
	defer st.Close()
	r := chi.NewRouter()
	r.Handle("/api/remote/{server}/*", proxy.New(resolverFunc(func(string) (proxy.Target, error) { return st, nil })))
	hub := httptest.NewServer(r)
	defer hub.Close()

	req, _ := http.NewRequest("POST", hub.URL+"/api/remote/a/api/board/team/messages", strings.NewReader(`{"content":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", "browser-hub-key")
	req.Header.Set("X-Coral-Session-Token", "agent-token")
	req.Header.Set("X-Coral-Hub-Role", "owner")
	req.Header.Set("X-Coral-Via-Tunnel", "1")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header["X-Coral-Hub-User"] = []string{"hub-user-1234abcd"}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	mu.Lock()
	defer mu.Unlock()
	if seen.Get("Authorization") != "Bearer "+streamKey {
		t.Errorf("Authorization = %q", seen.Get("Authorization"))
	}
	for k := range seen {
		c := http.CanonicalHeaderKey(k)
		if c == "X-Api-Key" || strings.HasPrefix(c, "X-Coral-") || strings.HasPrefix(c, "Sec-Fetch-") {
			t.Errorf("%s reached the remote over the stream: a request through the hub must stay an API key call", k)
		}
	}
}

type resolverFunc func(string) (proxy.Target, error)

func (f resolverFunc) Resolve(_ context.Context, id string) (proxy.Target, error) { return f(id) }

func TestStreamTargetCarriesAWebSocket(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+streamKey {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer c.CloseNow()
		typ, msg, err := c.Read(r.Context())
		if err == nil {
			c.Write(r.Context(), typ, msg)
		}
	}))
	defer remote.Close()
	ssh, _ := fakeSSHW(t)
	tg, _ := ParseTarget("rich@box.example.com")
	st, _ := NewStreamTarget(Runner{SSH: ssh}, tg, portOf(t, remote), streamKey)
	defer st.Close()
	c, err := st.DialWS(context.Background(), "/ws/coral", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(context.Background(), websocket.MessageText, []byte("ping")); err != nil {
		t.Fatal(err)
	}
	_, msg, err := c.Read(context.Background())
	if err != nil || string(msg) != "ping" {
		t.Errorf("echo = %q, %v", msg, err)
	}
	bad, _ := NewStreamTarget(Runner{SSH: ssh}, tg, portOf(t, remote), "wrong-key")
	defer bad.Close()
	if _, err := bad.DialWS(context.Background(), "/ws/coral", "", nil); err != proxy.ErrRemoteRejected {
		t.Errorf("a rejected key: %v", err)
	}
}

func TestNewStreamTargetRefusesWhatItCannotUse(t *testing.T) {
	tg, _ := ParseTarget("rich@box.example.com")
	for _, c := range []struct {
		t    Target
		port int
		key  string
	}{{tg, 0, "k"}, {tg, 70000, "k"}, {tg, 8420, ""}, {Target{User: "x y", Host: "box", Port: 22}, 8420, "k"}, {Target{Alias: "-oProxyCommand=x"}, 8420, "k"}} {
		if _, err := NewStreamTarget(Runner{}, c.t, c.port, c.key); err == nil {
			t.Errorf("accepted %+v %d %q", c.t, c.port, c.key)
		}
	}
}

func TestStreamTargetCapsConnectionsAndBacksOffAfterAFailedDial(t *testing.T) {
	dir := t.TempDir()
	hold := filepath.Join(dir, "ssh")
	if err := os.WriteFile(hold, []byte("#!/bin/sh\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	tg, _ := ParseTarget("rich@box.example.com")
	st, _ := NewStreamTarget(Runner{SSH: hold}, tg, 8420, streamKey)
	var conns []net.Conn
	for i := 0; i < streamCap; i++ {
		c, err := st.dial(context.Background())
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		conns = append(conns, c)
	}
	if _, err := st.dial(context.Background()); !errors.Is(err, ErrStreamBusy) {
		t.Errorf("past the cap: %v", err)
	}
	conns[0].Close()
	deadline := time.Now().Add(5 * time.Second)
	var c net.Conn
	var err error
	for time.Now().Before(deadline) { // the slot comes back when the process is gone
		if c, err = st.dial(context.Background()); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("a closed stream did not give its slot back: %v", err)
	}
	conns = append(conns[1:], c)
	for _, c := range conns {
		c.Close()
	}

	fail := filepath.Join(dir, "ssh-fail")
	if err := os.WriteFile(fail, []byte("#!/bin/sh\necho 'Connection refused' >&2\nexit 255\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	bad, _ := NewStreamTarget(Runner{SSH: fail}, tg, 8420, streamKey)
	fc, err := bad.dial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(fc) // ssh exits 255 at once: the read ends and the failure is noted
	time.Sleep(200 * time.Millisecond)
	if _, err := bad.dial(context.Background()); !errors.Is(err, ErrStreamBackoff) {
		t.Errorf("right after a failed connection: %v", err)
	}
	bad.mu.Lock()
	bad.failed = time.Now().Add(-streamBackoff - time.Second)
	bad.mu.Unlock()
	if c, err := bad.dial(context.Background()); err != nil {
		t.Errorf("after the backoff: %v", err)
	} else {
		c.Close()
	}
}

func TestStreamArgvHasKeepAlive(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))
	defer remote.Close()
	ssh, log := fakeSSHW(t)
	tg, _ := ParseTarget("rich@box.example.com")
	st, _ := NewStreamTarget(Runner{SSH: ssh}, tg, portOf(t, remote), streamKey)
	defer st.Close()
	req, _ := http.NewRequest("GET", "http://x.invalid/api/health", nil)
	resp, err := st.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	b, _ := os.ReadFile(log)
	for _, want := range []string{"ServerAliveInterval=15", "ServerAliveCountMax=3"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("argv lacks %q:\n%s", want, b)
		}
	}
}
