package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/startup/locktest"
	"github.com/subgentic/coral/internal/tracking"
)

// sinkEvent is one event as the test sink received it.
type sinkEvent struct {
	Event      string         `json:"event"`
	DistinctID string         `json:"distinct_id"`
	Properties map[string]any `json:"properties"`
}

type eventSink struct {
	mu     sync.Mutex
	events []sinkEvent
}

func (s *eventSink) named(name string) []sinkEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []sinkEvent
	for _, e := range s.events {
		if e.Event == name {
			out = append(out, e)
		}
	}
	return out
}

func (s *eventSink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.events)
}

func newEventSink(t *testing.T) (*eventSink, string) {
	t.Helper()
	s := &eventSink{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var e sinkEvent
		_ = json.NewDecoder(r.Body).Decode(&e)
		s.mu.Lock()
		s.events = append(s.events, e)
		s.mu.Unlock()
	}))
	t.Cleanup(srv.Close)
	return s, srv.URL
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// startChild runs the tray's server child of bin on its own data folder, with the test sink and the given extra environment, and returns once it says it serves.
func startChild(t *testing.T, bin, dataDir, sinkURL string, port int, extra ...string) {
	t.Helper()
	cmd := exec.Command(bin, "--server-child", "--port", strconv.Itoa(port), "--backend", "pty")
	env := []string{}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "CORAL_") {
			env = append(env, kv)
		}
	}
	cmd.Env = append(env, append([]string{"CORAL_DATA_DIR=" + dataDir, "CORAL_TELEMETRY_TEST_SINK=" + sinkURL}, extra...)...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	t.Cleanup(func() {
		stdin.Close() // the stop request
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	ready := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(stdout)
		said := false
		for sc.Scan() {
			if !said && strings.TrimSpace(sc.Text()) == childSaysReady {
				said = true
				close(ready)
			}
		}
		_ = cmd.Wait()
	}()
	select {
	case <-ready:
	case <-done:
		t.Fatal("the server child exited before it served")
	case <-time.After(60 * time.Second):
		t.Fatal("the server child did not say it serves")
	}
}

// askStatus makes the server send a prerequisite_check (GET /api/system/status), signed in with the data folder's API key.
func askStatus(t *testing.T, dataDir string, port int) {
	t.Helper()
	key, err := os.ReadFile(filepath.Join(dataDir, "api_key"))
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/api/system/status", nil)
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(key)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status answered %d", resp.StatusCode)
	}
}

// The tray's server child sends the server's own events, under the install id the tray writes (even when it is written after the child started) and with the
// entrypoint coral-tray; with analytics switched off in the environment it sends none.
func TestTheTrayServerChildSendsTheServersEvents(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the program")
	}
	bin, ok := locktest.Build(t, ".")
	if !ok {
		t.Skip("coral-tray cannot be built here (it needs its platform libraries)")
	}

	t.Run("on", func(t *testing.T) {
		sink, url := newEventSink(t)
		dir := t.TempDir()
		port := freePort(t)
		startChild(t, bin, dir, url, port)
		// The tray writes the install id once the child says analytics is on, so after the child started.
		if err := os.WriteFile(filepath.Join(dir, ".install_id"), []byte("tray-child-test"), 0o600); err != nil {
			t.Fatal(err)
		}
		askStatus(t, dir, port)
		deadline := time.Now().Add(15 * time.Second)
		for len(sink.named("prerequisite_check")) == 0 && time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
		}
		got := sink.named("prerequisite_check")
		if len(got) == 0 {
			t.Fatalf("no prerequisite_check reached the sink (%d events)", sink.count())
		}
		if got[0].DistinctID != "tray-child-test" {
			t.Errorf("distinct_id = %q, want the tray's install id", got[0].DistinctID)
		}
		if ep := got[0].Properties["entrypoint"]; ep != "coral-tray" {
			t.Errorf("entrypoint = %v, want coral-tray", ep)
		}
	})

	t.Run("off", func(t *testing.T) {
		sink, url := newEventSink(t)
		dir := t.TempDir()
		port := freePort(t)
		startChild(t, bin, dir, url, port, "CORAL_TELEMETRY_DISABLED=1")
		if err := os.WriteFile(filepath.Join(dir, ".install_id"), []byte("tray-child-test"), 0o600); err != nil {
			t.Fatal(err)
		}
		askStatus(t, dir, port)
		time.Sleep(3 * time.Second)
		if n := sink.count(); n != 0 {
			t.Fatalf("analytics off, yet %d events reached the sink", n)
		}
	})
}

// The child's tracking waits for the Terms: while they are not accepted nothing is sent, and once they are, events go out.
func TestTheTrayServerChildWaitsForTheTerms(t *testing.T) {
	sink, url := newEventSink(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".install_id"), []byte("tray-child-terms"), 0o600); err != nil {
		t.Fatal(err)
	}
	prevKey := config.PostHogKey
	config.PostHogKey = "test-key"
	restore := tracking.ConfigureForTest(url, dir, "tray-child-terms")
	accepted := false
	prevTerms := termsAccepted
	termsAccepted = func() bool { return accepted }
	t.Cleanup(func() {
		restore()
		termsAccepted = prevTerms
		tracking.SetSendGate(nil)
		config.PostHogKey = prevKey
	})
	setupChildTracking(dir)

	tracking.TrackEvent(tracking.EventSessionLaunched, nil)
	tracking.WaitForAsyncForTest()
	if n := sink.count(); n != 0 {
		t.Fatalf("Terms not accepted, yet %d events reached the sink", n)
	}
	accepted = true
	tracking.TrackEvent(tracking.EventSessionLaunched, nil)
	tracking.WaitForAsyncForTest()
	if got := sink.named(tracking.EventSessionLaunched); len(got) != 1 {
		t.Fatalf("after acceptance want one event, got %d", len(got))
	}
}
