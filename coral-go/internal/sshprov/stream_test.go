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

// fakeSSHW is the stand-in ssh run as `ssh -W host:port`: it logs its argv and joins its stdin and stdout to the address -W names.
func fakeSSHW(t *testing.T) (ssh, log string) {
	t.Helper()
	log = filepath.Join(t.TempDir(), "argv")
	return newStandIn(t, "ssh", standCfg{Log: log, Pipe: true}), log
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
	tg, _ := ParseTarget("user@box.example.com:2222")
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
	for _, want := range []string{"-W\n127.0.0.1:", "StrictHostKeyChecking=yes", "-p\n2222\n", "--\nuser@box.example.com\n"} {
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
	tg, _ := ParseTarget("user@box.example.com")
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
	tg, _ := ParseTarget("user@box.example.com")
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
	tg, _ := ParseTarget("user@box.example.com")
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
	hold := newStandIn(t, "ssh", standCfg{HoldSecs: 30})
	tg, _ := ParseTarget("user@box.example.com")
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

	fail := newStandIn(t, "ssh", standCfg{Stderr: "Connection refused\n", Exit: 255})
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
	tg, _ := ParseTarget("user@box.example.com")
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

// The Operator's slow switching through a self-hosted hub over SSH (#12446): a switch is a burst of about 7 requests, and every connection of the burst is one `ssh -W` process. An idle pool of 4 dropped 3 of
// them after each burst and started 3 again at the next, a few seconds each on a real hop (measured: bursts of 3 to 9 s with a pool of 4, 0.1 to 0.9 s with 12). The pool is as big as a switch, so after the
// first burst the next ones start no process.
func TestStreamPoolKeepsAnAgentSwitchsConnectionsSoTheNextSwitchStartsNoSSH(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond) // longer than starting the seven streams: the requests of a burst are really at once
		io.WriteString(w, "ok")
	}))
	defer remote.Close()
	ssh, log := fakeSSHW(t)
	tg, _ := ParseTarget("user@box.example.com")
	st, err := NewStreamTarget(Runner{SSH: ssh}, tg, portOf(t, remote), streamKey)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	burst := func() {
		var wg sync.WaitGroup
		for i := 0; i < 7; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				req, _ := http.NewRequest("GET", "http://x.invalid/api/x", nil)
				resp, err := st.RoundTrip(req)
				if err != nil {
					t.Error(err)
					return
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}()
		}
		wg.Wait()
	}
	for i := 0; i < 5; i++ {
		burst()
		time.Sleep(150 * time.Millisecond) // the previous burst's closed streams are gone
	}
	b, _ := os.ReadFile(log)
	if n := strings.Count(string(b), "-W\n127.0.0.1:"); n > 8 {
		t.Errorf("5 bursts of 7 started %d ssh processes: the first burst needs 7 and the others should reuse them (a pool of 4 starts some more each time)", n)
	}
}

// A closed stream gives its slot back at once, not when its process has been collected: a switch closes a terminal socket and opens a new one in the same moment, and the burst after it must not meet
// "too many connections" (measured: bursts of 7 straight after bursts of 7 did).
func TestStreamGivesTheSlotBackWhenTheConnectionIsClosed(t *testing.T) {
	hold := newStandIn(t, "ssh", standCfg{HoldSecs: 30})
	tg, _ := ParseTarget("user@box.example.com")
	st, _ := NewStreamTarget(Runner{SSH: hold}, tg, 8420, streamKey)
	var conns []net.Conn
	for i := 0; i < streamCap; i++ {
		c, err := st.dial(context.Background())
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		conns = append(conns, c)
	}
	conns[0].Close()
	c, err := st.dial(context.Background())
	if err != nil {
		t.Fatalf("the slot of a closed stream was not free at once: %v", err)
	}
	conns = append(conns[1:], c)
	for _, c := range conns {
		c.Close()
	}
}

// QA's pins on the pool's numbers (#12469): the cap, the idle pool and how long it is kept, and the slot of a stream whose process ends by itself.
func TestStreamCapIs24AndThe25thDialIsRefused(t *testing.T) {
	hold := newStandIn(t, "ssh", standCfg{HoldSecs: 30})
	tg, _ := ParseTarget("user@box.example.com")
	st, _ := NewStreamTarget(Runner{SSH: hold}, tg, 8420, streamKey)
	var conns []net.Conn
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	for i := 0; i < 24; i++ {
		c, err := st.dial(context.Background())
		if err != nil {
			t.Fatalf("dial %d of 24: %v", i+1, err)
		}
		conns = append(conns, c)
	}
	if _, err := st.dial(context.Background()); !errors.Is(err, ErrStreamBusy) {
		t.Errorf("the 25th dial: %v", err)
	}
}

func TestStreamPoolKeepsTenIdleStreamsForFiveMinutes(t *testing.T) {
	tg, _ := ParseTarget("user@box.example.com")
	st, _ := NewStreamTarget(Runner{SSH: "ssh"}, tg, 8420, streamKey)
	tr := st.transport()
	if tr.MaxIdleConnsPerHost != 10 || tr.IdleConnTimeout != 5*time.Minute {
		t.Errorf("the pool keeps %d idle streams for %v; a switch is a burst of about 7 and the pool should hold it between switches (10 for 5 minutes)", tr.MaxIdleConnsPerHost, tr.IdleConnTimeout)
	}
}

// A stream whose ssh ends by itself (the far side hung up) is read to its end and gives its slot back without anyone closing it: the reap path frees it too, not only Close.
func TestStreamGivesTheSlotBackWhenTheProcessEndsByItself(t *testing.T) {
	quick := newStandIn(t, "ssh", standCfg{})
	tg, _ := ParseTarget("user@box.example.com")
	st, _ := NewStreamTarget(Runner{SSH: quick}, tg, 8420, streamKey)
	c, err := st.dial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(c) // the stand-in exits at once: the read ends, and the reap collects it
	deadline := time.Now().Add(5 * time.Second)
	for len(st.slots) != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := len(st.slots); n != 0 {
		t.Errorf("%d slot(s) still held after the process ended on its own", n)
	}
}

// The first switch after the shared ssh session expired (60 s idle) started about 7 `ssh -W` at once with no session to share: each did its own handshake and one could fail, which started the 3 s backoff (#12446,
// 4a; measured on a 94 ms hop: 1 to 3 s). A computer with no live stream and none for 45 s now gets one cheap command first, alone, that makes the session; the streams of the burst then ride it.
func useTestControlDir(t *testing.T) {
	t.Helper()
	if UseControlDir(filepath.Join(t.TempDir(), "ssh_control")) == "" {
		t.Skip("no shared-session folder on this system")
	}
	t.Cleanup(func() { controlDir.Store("") })
}

func TestStreamColdComputerMakesItsSharedSessionOnceBeforeTheBurstOpensItsStreams(t *testing.T) {
	useTestControlDir(t)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(100 * time.Millisecond)
		io.WriteString(w, "ok")
	}))
	defer remote.Close()
	ssh, log := fakeSSHW(t)
	tg, _ := ParseTarget("user@box.example.com")
	st, err := NewStreamTarget(Runner{SSH: ssh}, tg, portOf(t, remote), streamKey)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	burst := func() {
		var wg sync.WaitGroup
		for i := 0; i < 7; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				req, _ := http.NewRequest("GET", "http://x.invalid/api/x", nil)
				resp, err := st.RoundTrip(req)
				if err != nil {
					t.Error(err)
					return
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}()
		}
		wg.Wait()
	}
	burst()
	got := string(mustRead(t, log))
	warm, firstW := strings.Index(got, "uname"), strings.Index(got, "-W\n")
	if warm < 0 || firstW < 0 || warm > firstW {
		t.Errorf("the cold computer's first ssh must be the one command that makes the shared session, before any stream (uname at %d, first -W at %d):\n%s", warm, firstW, got)
	}
	if n := strings.Count(got, "uname"); n != 1 {
		t.Errorf("the session was made %d times by one burst", n)
	}
	before := strings.Count(got, "uname")
	burst() // the streams are idle in the pool and the session is in use: not cold
	if n := strings.Count(string(mustRead(t, log)), "uname"); n != before {
		t.Errorf("a warm computer made the session again (%d commands)", n)
	}
}

// One failed first attempt is one failure: the burst's other dials wait for it and then meet the backoff, rather than each starting an ssh of their own.
func TestStreamColdComputerThatCannotBeReachedStartsOneSSHForTheWholeBurst(t *testing.T) {
	useTestControlDir(t)
	log := filepath.Join(t.TempDir(), "argv")
	ssh := newStandIn(t, "ssh", standCfg{Stderr: "Connection refused\n", Exit: 255, Log: log})
	tg, _ := ParseTarget("user@box.example.com")
	st, _ := NewStreamTarget(Runner{SSH: ssh}, tg, 8420, streamKey)
	var wg sync.WaitGroup
	for i := 0; i < 7; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if c, err := st.dial(context.Background()); err == nil {
				c.Close()
				t.Error("a dial to a computer that refuses succeeded")
			}
		}()
	}
	wg.Wait()
	b := mustRead(t, log)
	if n := strings.Count(string(b), "--\nuser@box.example.com\n"); n != 1 {
		t.Errorf("%d ssh processes were started for one burst to a computer that refuses: the first failure should end the others' dials:\n%s", n, b)
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return b
}

// #12475 (Security's INFO on #12446): with sharing off, forgetting a host key closed no session, and the idle `ssh -W` streams the pool keeps (made under the key just forgotten) lived their five minutes. CloseShared
// now ends the idle streams of every stream target of that computer, and only that computer's.
func TestForgettingAHostKeyClosesTheIdleStreamsOfThatComputerOnly(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		io.WriteString(w, "ok")
	}))
	defer remote.Close()
	ssh, _ := fakeSSHW(t)
	mk := func(dest string) *StreamTarget {
		tg, _ := ParseTarget(dest)
		st, err := NewStreamTarget(Runner{SSH: ssh}, tg, portOf(t, remote), streamKey)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(st.Close)
		return st
	}
	burst := func(st *StreamTarget) {
		var wg sync.WaitGroup
		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				req, _ := http.NewRequest("GET", "http://x.invalid/api/x", nil)
				resp, err := st.RoundTrip(req)
				if err != nil {
					t.Error(err)
					return
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
			}()
		}
		wg.Wait()
	}
	a, b := mk("user@a.example.com"), mk("user@b.example.com")
	burst(a)
	burst(b)
	time.Sleep(100 * time.Millisecond)
	if len(a.slots) == 0 || len(b.slots) == 0 {
		t.Fatalf("the pools keep idle streams after a burst: a %d, b %d", len(a.slots), len(b.slots))
	}
	if len(controlArgs()) != 0 {
		t.Fatal("this test is about sharing being off")
	}
	tg, _ := ParseTarget("user@a.example.com")
	Runner{SSH: ssh}.CloseShared(context.Background(), tg)
	deadline := time.Now().Add(3 * time.Second)
	for len(a.slots) != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := len(a.slots); n != 0 {
		t.Errorf("a's idle streams are still open after its host key was forgotten: %d", n)
	}
	if len(b.slots) == 0 {
		t.Error("another computer's streams were closed too")
	}
}
