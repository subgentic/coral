package opencode

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMain makes this test binary the stand-in opencode when asked: `<binary> serve --hostname H --port P` listens on P, answers the messages route behind the password it was given in its environment,
// and writes the environment it saw to a file, so a test can read what the server was given.
//
// The stand-in is told apart by ITS ARGUMENTS ALONE: the first one is "serve". The test runner never starts this binary that way (its arguments are -test flags), and no variable is needed, which matters:
// the server's environment is filtered (agentenv.Filter drops every CORAL_ variable), so a guard variable named CORAL_... never reached the child, the child took itself for a test run, ran every test,
// and each of those started another stand-in: 357, then 1,864 processes, three crashes of the operator's Mac (#11377). A child that is the stand-in never calls m.Run().
func TestMain(m *testing.M) {
	switch binaryMode(os.Args) {
	case modeStandIn:
		runStub()
		os.Exit(0)
	case modeRefuse:
		fmt.Fprintln(os.Stderr, "opencode tests: this binary runs tests only under go test (-test. flags) and answers `serve` as the stand-in; nothing else")
		os.Exit(2)
	}
	os.Exit(m.Run())
}

const (
	modeTests   = iota // go test's own start: no arguments, or a -test. flag first
	modeStandIn        // started as `<binary> serve ...` by Start: answer as the opencode server, run no test
	modeRefuse         // anything else: run nothing, exit 2 (a copy of this binary that was handed something this package never hands it can never run the suite)
)

// binaryMode decides what this test binary is from its arguments alone (Security's #137647: a cap per process cannot stop a recursion across processes, a decision that never runs the suite for an
// unexpected start can). Pure: the test of it spawns nothing.
func binaryMode(args []string) int {
	switch {
	case len(args) <= 1:
		return modeTests
	case strings.HasPrefix(args[1], "-test."):
		return modeTests
	case args[1] == "serve":
		return modeStandIn
	}
	return modeRefuse
}

func TestTheBinaryRunsTestsOnlyUnderGoTestAndIsTheStandInOnlyForServe(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want int
	}{
		{[]string{"opencode.test"}, modeTests},
		{[]string{"opencode.test", "-test.v"}, modeTests},
		{[]string{"opencode.test", "-test.run=^TestX$", "-test.count=1"}, modeTests},
		{[]string{"opencode.test", "serve"}, modeStandIn},
		{[]string{"opencode.test", "serve", "--hostname", "127.0.0.1", "--port", "4096"}, modeStandIn},
		{[]string{"opencode.test", "--version"}, modeRefuse},
		{[]string{"opencode.test", "run"}, modeRefuse},
		{[]string{"opencode.test", "Serve"}, modeRefuse},
		{[]string{"opencode.test", "serve2"}, modeRefuse},
		{[]string{"opencode.test", "-v"}, modeRefuse},
		{[]string{"opencode.test", "test.run=x"}, modeRefuse},
		{[]string{"opencode.test", "", "serve"}, modeRefuse},
	} {
		assert.Equal(t, tc.want, binaryMode(tc.args), "%v", tc.args)
	}
}

// standInPassword is the password the stand-in asks for: the one in OPENCODE_SERVER_PASSWORD (1.x) or OPENCODE_PASSWORD (2.x), like the real builds read theirs.
func standInPassword() string {
	if p := os.Getenv("OPENCODE_SERVER_PASSWORD"); p != "" {
		return p
	}
	return os.Getenv("OPENCODE_PASSWORD")
}

// standInAuthorized is the stand-in's password check; STANDIN_IGNORE_PASSWORD=1 makes it a server that ignores its password variable altogether (opencode 1.x given only OPENCODE_PASSWORD: it is OPEN).
func standInAuthorized(r *http.Request) bool {
	if os.Getenv("STANDIN_IGNORE_PASSWORD") == "1" {
		return true
	}
	_, p, ok := r.BasicAuth()
	return ok && p == standInPassword()
}

func runStub() {
	var port string
	for i, a := range os.Args {
		if a == "--port" && i+1 < len(os.Args) {
			port = os.Args[i+1]
		}
	}
	if out := os.Getenv(envFileVar); out != "" {
		if f, err := os.OpenFile(out+".pids", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil { // every stand-in started, so a test can see that none is left
			fmt.Fprintln(f, os.Getpid())
			f.Close()
		}
		seen := map[string]string{"args": strings.Join(os.Args[1:], " ")}
		for _, k := range []string{"OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG", "OPENCODE_DB", "OPENCODE_SERVER_URL", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "HOME", "CORAL_SESSION_TOKEN", "CORAL_INITIAL_PASSWORD_FILE", "CORAL_URL", "CORAL_SESSION_NAME", "ANTHROPIC_API_KEY_OF_ANOTHER_AGENT"} {
			seen[k] = os.Getenv(k)
		}
		b, _ := json.Marshal(seen)
		_ = os.WriteFile(out, b, 0o600)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/session", func(w http.ResponseWriter, r *http.Request) {
		if !standInAuthorized(r) {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `{"data":[]}`)
	})
	// 1.x: the messages are on /session/<id>/message in the {info, parts} shape (what the real 1.19.5 sends); /api/session/<id>/message is an empty list there
	// POST /permission/<id>/reply?directory=<dir> {"reply": ...}: 1.x's answer to a permission request. Recorded as "id|reply|directory"; an id "per_unknown" is not open (404).
	mux.HandleFunc("/permission/", func(w http.ResponseWriter, r *http.Request) {
		if !standInAuthorized(r) || r.Method != http.MethodPost {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/permission/"), "/reply")
		if id == "per_unknown" {
			http.Error(w, `{"_tag":"PermissionNotFoundError"}`, http.StatusNotFound)
			return
		}
		var body struct {
			Reply string `json:"reply"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if out := os.Getenv(envFileVar); out != "" {
			if f, err := os.OpenFile(out+".replies", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
				fmt.Fprintf(f, "%s|%s|%s\n", id, body.Reply, r.URL.Query().Get("directory"))
				f.Close()
			}
		}
		fmt.Fprint(w, "true")
	})
	mux.HandleFunc("/session/ses_abc123/message", func(w http.ResponseWriter, r *http.Request) {
		if !standInAuthorized(r) {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `[{"info":{"id":"m1","sessionID":"ses_abc123","role":"assistant","time":{"created":1793405453115,"completed":1793405455382}},"parts":[{"type":"step-start"},{"type":"text","text":"hello from the 1.x stand-in"},{"type":"step-finish"}]}]`)
	})
	mux.HandleFunc("/api/session/ses_abc123/message", func(w http.ResponseWriter, r *http.Request) {
		if !standInAuthorized(r) {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		if f := os.Getenv(messagesFileVar); f != "" {
			b, _ := os.ReadFile(f)
			w.Write(b)
			return
		}
		fmt.Fprint(w, `{"items":[{"id":"m1","type":"assistant","text":"hello from the stand-in"}]}`)
	})
	if frames := os.Getenv(eventsFileVar); frames != "" {
		// 1.x streams a turn's state on /event and a thinner durable stream on /api/event (no session.status, no session.idle: checked on 1.19.5); 2.x on /api/event. /global/event is every folder's events, each wrapped with its directory. STANDIN_SILENT_API_EVENT=1 is the 1.x shape.
		stream := func(silent bool) http.HandlerFunc { // the frames file holds what each stream sends
			return func(w http.ResponseWriter, r *http.Request) {
				if !standInAuthorized(r) {
					http.Error(w, "no", http.StatusUnauthorized)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				if silent {
					fmt.Fprint(w, "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n")
				} else {
					b, _ := os.ReadFile(frames)
					w.Write(b)
				}
				w.(http.Flusher).Flush()
				<-r.Context().Done() // the stream stays open until the reader leaves
			}
		}
		mux.HandleFunc("/api/event", stream(os.Getenv("STANDIN_SILENT_API_EVENT") == "1"))
		mux.HandleFunc("/global/event", stream(false))
	}
	if ms, _ := strconv.Atoi(os.Getenv(listenDelayVar)); ms > 0 {
		time.Sleep(time.Duration(ms) * time.Millisecond) // a server that is slow to come up
	}
	if os.Getenv("STANDIN_NO_BIND") == "1" {
		select {} // alive, never listening: ended by the signal Stop sends
	}
	l, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		os.Exit(3)
	}
	_ = http.Serve(l, mux)
}

// envFileVar names where the stand-in writes the environment it saw. Not a CORAL_, OPENCODE_ or XDG_ name: the server's environment filter keeps nothing of those, and this must reach the stand-in.
const messagesFileVar = "STANDIN_MESSAGES_FOR_TESTS" // a file the stand-in answers the messages route with, newest first

const listenDelayVar = "STANDIN_LISTEN_DELAY_MS_FOR_TESTS"

const eventsFileVar = "STANDIN_EVENTS_FOR_TESTS" // a file of SSE frames the stand-in sends on /api/event, then holds the stream open

const envFileVar = "STANDIN_ENVFILE_FOR_TESTS"

// What one TEST may do with stand-in servers (per test, so a repeated run, -count=2, starts afresh): it may take stubConfig at most maxStubConfigsPerTest times, and its stand-ins, counted by the pids each one
// records, may be at most maxStandInProcsPerTest when it ends. A test that loops starting servers fails at once at the first, and one that started too many fails when it ends. The fork bomb of #11377 (a
// stand-in that re-ran the suite) is stopped by binaryMode, which decides from the arguments alone and never runs the suite for a start it does not know: these are the second line.
const (
	maxStubConfigsPerTest  = 4
	maxStandInProcsPerTest = 16
)

// tooManyStubConfigs says whether a test that has taken stubConfig n times has taken too many.
func tooManyStubConfigs(n int) bool { return n > maxStubConfigsPerTest }

// standInProcs is how many stand-in processes recorded their pid for this test's env file.
func standInProcs(envFile string) int {
	raw, err := os.ReadFile(envFile + ".pids")
	if err != nil {
		return 0
	}
	return len(strings.Fields(string(raw)))
}

var (
	stubMu     sync.Mutex
	stubByTest = map[testing.TB]int{}
)

func stubConfig(t *testing.T) (Config, string) {
	t.Helper()
	stubMu.Lock()
	stubByTest[t]++
	n := stubByTest[t]
	stubMu.Unlock()
	t.Cleanup(func() { stubMu.Lock(); delete(stubByTest, t); stubMu.Unlock() })
	if tooManyStubConfigs(n) {
		t.Fatalf("this test took %d stand-in configs: more than the %d any test here needs (a start that loops?)", n, maxStubConfigsPerTest)
	}
	exe, err := os.Executable()
	require.NoError(t, err)
	envFile := filepath.Join(t.TempDir(), "env.json")
	t.Setenv(envFileVar, envFile)
	t.Cleanup(func() {
		if n := standInProcs(envFile); n > maxStandInProcsPerTest {
			t.Errorf("this test started %d stand-in processes: more than the %d any test here needs", n, maxStandInProcsPerTest)
		}
	})
	cfg := Config{Bin: exe, DataDir: filepath.Join(t.TempDir(), "opencode"), Ready: 10 * time.Second, Version: "2.2.4"} // the stand-in cannot answer --version: its version is said
	// whatever a test leaves running is stopped by the pid Coral recorded for it, when the test ends
	t.Cleanup(func() {
		recs, _ := filepath.Glob(filepath.Join(cfg.DataDir, "servers", "*", "server.json"))
		for _, f := range recs {
			stopLeftOver(f)
		}
	})
	return cfg, envFile
}

func TestTheServerRunsInCoralsOwnFolderBehindItsOwnPasswordAndIsStoppedByItsPid(t *testing.T) {
	// the person's own opencode settings are in this process's environment: none of them reach the server
	t.Setenv("OPENCODE_DB", "/home/person/.local/share/opencode/opencode.db")
	t.Setenv("OPENCODE_SERVER_URL", "http://127.0.0.1:4096")
	t.Setenv("XDG_DATA_HOME", "/home/person/.local/share")
	cfg, envFile := stubConfig(t)
	s, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	defer s.Stop()

	var seen map[string]string
	raw, err := os.ReadFile(envFile)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &seen))
	assert.Equal(t, "", seen["OPENCODE_DB"], "the person's own database setting is not passed on")
	assert.Equal(t, "", seen["OPENCODE_SERVER_URL"], "nor the person's own server")
	for k, sub := range map[string]string{"XDG_DATA_HOME": "data", "XDG_CONFIG_HOME": "config", "XDG_CACHE_HOME": "cache", "XDG_STATE_HOME": "state"} {
		assert.Equal(t, filepath.Join(cfg.DataDir, sub), seen[k], k+" is Coral's folder, not the person's")
	}
	assert.Len(t, seen["OPENCODE_PASSWORD"], 64, "a generated password of 32 random bytes")
	assert.True(t, strings.HasPrefix(s.URL, "http://127.0.0.1:"), "on a loopback port")
	assert.NotContains(t, seen["args"], seen["OPENCODE_PASSWORD"], "the password is not in the arguments")
	assert.Equal(t, "OPENCODE_PASSWORD="+seen["OPENCODE_PASSWORD"], s.PasswordEnv())

	c, err := s.Client()
	require.NoError(t, err)
	msg, ok, err := c.LastMessage(context.Background(), "ses_abc123")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, "hello from the stand-in", msg.Text, "read through the API with that password")
	wrong, _ := New(s.URL, "not-the-password")
	_, err = wrong.Messages(context.Background(), "ses_abc123", MessagesOpts{})
	assert.ErrorContains(t, err, "401")

	rec, err := os.ReadFile(filepath.Join(cfg.DataDir, "servers", "agent-1", "server.json"))
	require.NoError(t, err)
	assert.NotContains(t, string(rec), seen["OPENCODE_PASSWORD"], "the pid file holds the pid and the port, never the password")
	var pr pidRecord
	require.NoError(t, json.Unmarshal(rec, &pr))
	assert.Equal(t, s.cmd.Process.Pid, pr.PID)
	info, err := os.Stat(cfg.DataDir)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o700), info.Mode().Perm(), "Coral's folder for it is the owner's alone")

	port := strings.TrimPrefix(s.URL, "http://127.0.0.1:")
	s.Stop()
	_, err = net.DialTimeout("tcp", "127.0.0.1:"+port, 300*time.Millisecond)
	assert.Error(t, err, "stopped")
	_, err = os.Stat(filepath.Join(cfg.DataDir, "servers", "agent-1", "server.json"))
	assert.True(t, os.IsNotExist(err), "and its pid file is gone")
}

func TestAServerThatExitsBeforeItAnswersIsAnErrorAndLeavesNothingRunning(t *testing.T) {
	cfg, _ := stubConfig(t)
	cfg.Args = func(int) []string { return []string{"serve", "--port", "1"} } // port 1 cannot be listened on: the stand-in exits
	cfg.Ready = 5 * time.Second
	_, err := Start(context.Background(), cfg, "agent-1")
	assert.ErrorContains(t, err, "exited before it answered")
	_, statErr := os.Stat(filepath.Join(cfg.DataDir, "servers", "agent-1", "server.json"))
	assert.True(t, os.IsNotExist(statErr))
}

func TestALeftOverPidIsSignalledOnlyWhenItsCommandAndStartTimeAreTheRecordedOnes(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "server.json")
	me := os.Getpid()
	write := func(rec pidRecord) {
		b, _ := json.Marshal(rec)
		require.NoError(t, os.WriteFile(f, b, 0o600))
	}
	// this test process's own pid, with a command and a start time that are not its: never signalled (it would end the test)
	for _, rec := range []pidRecord{
		{PID: me, Port: 54321, Command: "serve --port 54321", Started: processStart(me)},                 // a command that is not its own
		{PID: me, Port: 54321, Command: strings.Join(os.Args, " "), Started: "Mon Jan  1 00:00:00 2001"}, // its own command, another start time
		{PID: me, Port: 54321, Command: "", Started: processStart(me)},                                   // a record from before the command was kept
		{PID: me, Port: 54321, Command: strings.Join(os.Args, " ")},                                      // no start time
		{PID: 1, Port: 1, Command: "launchd", Started: "x"},                                              // never pid 1
	} {
		write(rec)
		stopLeftOver(f) // must not signal this process
		_, err := os.Stat(f)
		assert.True(t, os.IsNotExist(err), "the record is dropped: %+v", rec)
	}
	assert.False(t, isRecordedServer(pidRecord{PID: 1 << 30, Command: "x", Started: "y"}), "no such process")
}

func TestALeftOverServerOfTheSameAgentIsStoppedByItsExactCommand(t *testing.T) {
	cfg, _ := stubConfig(t)
	first, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	pid := first.cmd.Process.Pid
	// a Coral that crashed: its record is there, its server is still running; the next Start for the same agent stops it, by that pid
	second, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	defer second.Stop()
	select {
	case <-first.done:
	case <-time.After(5 * time.Second):
		t.Fatalf("the left-over server (pid %d) was not stopped", pid)
	}
	assert.NotEqual(t, first.URL, second.URL)
}

func TestEachAgentHasItsOwnServerPasswordAndPort(t *testing.T) {
	cfg, _ := stubConfig(t)
	a, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	defer a.Stop()
	b, err := Start(context.Background(), cfg, "agent-2")
	require.NoError(t, err)
	defer b.Stop()
	assert.NotEqual(t, a.URL, b.URL, "two ports")
	assert.NotEqual(t, a.PasswordEnv(), b.PasswordEnv(), "two passwords")
	pa, _ := a.PasswordFile()
	pb, _ := b.PasswordFile()
	assert.NotEqual(t, pa, pb)
	cb, err := b.Client()
	require.NoError(t, err)
	_, _, err = cb.LastMessage(context.Background(), "ses_abc123")
	require.NoError(t, err)
	wrong, _ := New(b.URL, strings.TrimPrefix(a.PasswordEnv(), "OPENCODE_PASSWORD="))
	_, err = wrong.Messages(context.Background(), "ses_abc123", MessagesOpts{})
	assert.ErrorContains(t, err, "401", "one agent's password does not open another agent's server")
	_, err = Start(context.Background(), cfg, "../agent")
	assert.Error(t, err, "a key is a plain name")
}

func TestThePortIsOnlyTrustedWhenTheChildIsAliveAndAnswersAsItself(t *testing.T) {
	cfg, _ := stubConfig(t)
	// a stranger holds a port and answers 200 to everything, with no password at all
	stranger := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"data":[]}`) }))
	defer stranger.Close()
	strangerPort, _ := strconv.Atoi(stranger.Listener.Addr().String()[strings.LastIndex(stranger.Listener.Addr().String(), ":")+1:])
	ports := []int{strangerPort}
	cfg.pickPort = func() (int, error) {
		if len(ports) > 0 {
			p := ports[0]
			ports = ports[1:]
			return p, nil
		}
		return freeLoopbackPort()
	}
	s, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err, "the first port is the stranger's: its child cannot listen and exits, so the next port is tried")
	defer s.Stop()
	assert.NotContains(t, s.URL, strconv.Itoa(strangerPort))
	c, _ := s.Client()
	_, _, err = c.LastMessage(context.Background(), "ses_abc123")
	assert.NoError(t, err, "and the server that is trusted is the one that was started")
}

func TestTheServersEnvironmentIsTheAgentsFilteredOneAndOnlyWhatOpencodeNeeds(t *testing.T) {
	t.Setenv("CORAL_SESSION_TOKEN", "tok-of-the-agent-that-started-coral")
	t.Setenv("CORAL_INITIAL_PASSWORD_FILE", "/tmp/pw")
	t.Setenv("CORAL_URL", "http://127.0.0.1:8420")
	t.Setenv("CORAL_SESSION_NAME", "claude-x")
	cfg, envFile := stubConfig(t)
	s, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	defer s.Stop()
	var seen map[string]string
	raw, _ := os.ReadFile(envFile)
	require.NoError(t, json.Unmarshal(raw, &seen))
	for _, k := range []string{"CORAL_SESSION_TOKEN", "CORAL_INITIAL_PASSWORD_FILE", "CORAL_URL", "CORAL_SESSION_NAME"} {
		assert.Equal(t, "", seen[k], k+" does not reach the server")
	}
	assert.NotEmpty(t, seen["HOME"], "the rest of the person's environment does (opencode needs its HOME and PATH)")
}

func TestThePrivateWriterRefusesALinkAndReplacesByRename(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "secret-target")
	require.NoError(t, os.WriteFile(target, []byte("keep"), 0o600))
	p := filepath.Join(dir, "password")
	require.NoError(t, os.Symlink(target, p)) // a link planted where the password goes
	require.NoError(t, writePrivate(p, []byte("pw")), "a link at the final name is replaced by rename, never written through")
	b, _ := os.ReadFile(target)
	assert.Equal(t, "keep", string(b), "what the link pointed at is untouched")
	b, _ = os.ReadFile(p)
	assert.Equal(t, "pw", string(b))
	info, _ := os.Lstat(p)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
	assert.True(t, info.Mode().IsRegular())
	// a planted temp name is not reused: the writer picks its own
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		assert.False(t, strings.HasSuffix(e.Name(), ".tmp"), "no temp file is left")
	}
}

func TestThePasswordFileIsPrivateAndHoldsOnlyThePassword(t *testing.T) {
	cfg, envFile := stubConfig(t)
	s, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	defer s.Stop()
	p, err := s.PasswordFile()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(cfg.DataDir, "servers", "agent-1", "password"), p)
	info, err := os.Stat(p)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
	b, _ := os.ReadFile(p)
	var seen map[string]string
	raw, _ := os.ReadFile(envFile)
	require.NoError(t, json.Unmarshal(raw, &seen))
	assert.Equal(t, seen["OPENCODE_PASSWORD"], string(b), "the same password the server was given")
}

// An open "stranger" holds the first port (#138222). The wrong password is sent first, and only a server that refuses it is sent the real one: an open stranger answers 200 to the wrong one and is refused, so
// the real password never reaches it. Two shapes, both deterministic:
//   - the stand-in child stays ALIVE and does not bind (STANDIN_NO_BIND): the stranger is always probed, the start fails on it, and every request the stranger saw carried only a "not-" password;
//   - the child fails to bind and EXITS at once: whether the stranger is probed before the exit is noticed is a race, so what is asserted is what holds either way: no request carried the real password.
func strangerOnTheFirstPort(t *testing.T, cfg *Config) (seen func() []string) {
	t.Helper()
	var mu sync.Mutex
	var got []string
	stranger := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pw, _ := r.BasicAuth()
		mu.Lock()
		got = append(got, pw)
		mu.Unlock()
		fmt.Fprint(w, `{"data":[]}`)
	}))
	t.Cleanup(stranger.Close)
	port, _ := strconv.Atoi(stranger.Listener.Addr().String()[strings.LastIndex(stranger.Listener.Addr().String(), ":")+1:])
	ports := []int{port}
	cfg.pickPort = func() (int, error) {
		if len(ports) > 0 {
			p := ports[0]
			ports = ports[1:]
			return p, nil
		}
		return freeLoopbackPort()
	}
	return func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), got...) }
}

func TestAnOpenStrangerIsAlwaysProbedWhenTheChildStaysAliveAndIsNeverSentTheRealPassword(t *testing.T) {
	t.Setenv("STANDIN_NO_BIND", "1") // the child lives, never listens: the loop cannot see it exit before it probes
	cfg, _ := stubConfig(t)
	cfg.Ready = 5 * time.Second
	seen := strangerOnTheFirstPort(t, &cfg)
	_, err := Start(context.Background(), cfg, "agent-1")
	require.Error(t, err, "the stranger answers a wrong password with 200: refused")
	pws := seen()
	require.NotEmpty(t, pws, "the stranger was probed")
	for _, pw := range pws {
		assert.True(t, strings.HasPrefix(pw, "not-"), "only the wrong password reached a server that asks for none, got %q", pw)
	}
}

func TestAStrangerIsNeverSentTheRealPasswordWhenTheChildExitsAtOnce(t *testing.T) {
	cfg, _ := stubConfig(t)
	seen := strangerOnTheFirstPort(t, &cfg)
	s, err := Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err, "the child could not bind the stranger's port and exited: the next port is tried")
	defer s.Stop()
	for _, pw := range seen() { // empty or not, depending on which the loop notices first: never the real password
		assert.True(t, strings.HasPrefix(pw, "not-"), "got %q", pw)
	}
}

func TestTheModelIsATopLevelModelOfTheServersOwnConfigFileAndOnlyAValidOne(t *testing.T) {
	t.Setenv("OPENCODE_CONFIG", "/home/person/their-own-opencode.json")
	cfg, envFile := stubConfig(t)
	read := func() map[string]string {
		var seen map[string]string
		raw, _ := os.ReadFile(envFile)
		require.NoError(t, json.Unmarshal(raw, &seen))
		return seen
	}
	s, err := Start(context.Background(), cfg, "none")
	require.NoError(t, err)
	assert.Empty(t, read()["OPENCODE_CONFIG"], "no model: no config, and the person's own is not passed on")
	s.Stop()

	cfg.Model = "openai/gpt-6#high"
	s, err = Start(context.Background(), cfg, "agent-1")
	require.NoError(t, err)
	defer s.Stop()
	file := filepath.Join(cfg.DataDir, "servers", "agent-1", "opencode.json")
	assert.Equal(t, file, read()["OPENCODE_CONFIG"])
	b, err := os.ReadFile(file)
	require.NoError(t, err)
	var conf map[string]string
	require.NoError(t, json.Unmarshal(b, &conf))
	assert.Equal(t, "openai/gpt-6#high", conf["model"])
	fi, _ := os.Stat(file)
	assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm())

	for _, bad := range []string{"gpt-6", "-openai/x", "openai/x y", "openai/x\"}", "openai/x#", "a/b#c#d", "openai/$(id)"} {
		cfg.Model = bad
		_, err := Start(context.Background(), cfg, "agent-2")
		assert.Error(t, err, bad)
	}
}
