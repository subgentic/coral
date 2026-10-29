package testguard

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/subgentic/coral/internal/linktest"
)

func TestCheckDataPathPanicsOnRealCoralDir(t *testing.T) {
	if len(protectedDirs()) == 0 {
		t.Skip("no home directory to protect")
	}
	real := protectedDirs()[0]
	for _, p := range []string{real, filepath.Join(real, "tmux.sock"), filepath.Join(real, "sub", "..", "sessions.db")} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("CheckDataPath(%q) did not panic", p)
				}
			}()
			CheckDataPath(p)
		}()
	}
}

func TestCheckDataPathAllowsOtherDirs(t *testing.T) {
	CheckDataPath("")
	CheckDataPath(t.TempDir())
	CheckDataPath(filepath.Join(t.TempDir(), ".coral", "tmux.sock"))
	if len(protectedDirs()) > 0 {
		CheckDataPath(protectedDirs()[0] + "-other") // sibling, not inside
	}
}

func TestCheckDataPathIsInertOutsideTests(t *testing.T) {
	if len(protectedDirs()) == 0 {
		t.Skip("no home directory to protect")
	}
	enabled = func() bool { return false }
	t.Cleanup(func() { enabled = testing.Testing })
	CheckDataPath(protectedDirs()[0])
}

func TestLiveServerAddrs(t *testing.T) {
	live := liveServerAddrs("http://127.0.0.1:9123", "9200")
	for _, addr := range []string{"127.0.0.1:9123", "localhost:9123", "127.0.0.1:8420", "LOCALHOST:8420", "[::1]:8420", "127.0.0.1:9200"} {
		if !live[normalizeAddr(addr)] {
			t.Errorf("%s should be refused", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1:54321", "example.com:8420", "10.0.0.5:9123"} {
		if live[normalizeAddr(addr)] {
			t.Errorf("%s should be allowed", addr)
		}
	}
	if !liveServerAddrs("https://coral.example", "")[normalizeAddr("coral.example:443")] {
		t.Error("CORAL_URL without a port should use the scheme's port")
	}
}

func TestCheckDialPanicsOnLiveServer(t *testing.T) {
	live := liveServerAddrs("", "")
	func() {
		defer func() {
			if recover() == nil {
				t.Error("dialing 127.0.0.1:8420 did not panic")
			}
		}()
		checkDial(live, "127.0.0.1:8420")
	}()
	checkDial(live, "127.0.0.1:1") // not the live server
}

// In a test binary the guard is installed and the agent's tmux is dropped.
func TestInitGuardsDefaultTransportAndTmux(t *testing.T) {
	if os.Getenv("TMUX") != "" || os.Getenv("TMUX_PANE") != "" {
		t.Error("TMUX should be unset in test binaries")
	}
	tr := http.DefaultTransport.(*http.Transport)
	if tr.DialContext == nil {
		t.Fatal("DialContext not installed")
	}
	defer func() {
		if recover() == nil {
			t.Error("default transport dialed the live server without panicking")
		}
	}()
	tr.DialContext(context.Background(), "tcp", "localhost:8420")
}

// A symlink to the data dir, or a different case on macOS, is still the data
// dir; a sibling is not.
func TestProtectedInResolvesSymlinksAndCase(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "coral-home", ".coral")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	linktest.Symlink(t, real, link)
	dirs := []string{real}
	for _, p := range []string{
		filepath.Join(real, "tmux.sock"),
		filepath.Join(link, "tmux.sock"),                // through a symlink
		filepath.Join(link, "not", "yet", "created.db"), // missing path under a symlink
	} {
		if _, ok := protectedIn(p, dirs); !ok {
			t.Errorf("%s should be protected", p)
		}
	}
	if runtime.GOOS == "darwin" {
		if _, ok := protectedIn(filepath.Join(root, "coral-home", ".Coral", "sessions.db"), dirs); !ok {
			t.Error(".Coral should match .coral on macOS")
		}
	}
	for _, p := range []string{filepath.Join(root, "coral-home", ".coral-other", "x"), filepath.Join(root, "elsewhere")} {
		if _, ok := protectedIn(p, dirs); ok {
			t.Errorf("%s should not be protected", p)
		}
	}
}

// A data path inside the module's source tree fails the test at the call: that is how a Config with no data folder wrote api_key, messageboard.db and themes into
// cmd/coral for months, and made the go test cache miss for every package that scans the tree.
func TestCheckDataPathPanicsInsideTheSourceTree(t *testing.T) {
	panics := func(p string) (did bool) {
		defer func() { did = recover() != nil }()
		CheckDataPath(p)
		return false
	}
	root := sourceTree()
	if root == "" {
		t.Fatal("the test runs inside the module: no go.mod found above the working directory")
	}
	for _, p := range []string{root, filepath.Join(root, "cmd", "coral"), filepath.Join(root, "internal", "x", "api_key"), "."} {
		if !panics(p) {
			t.Errorf("a data path in the source tree did not fail the test: %q", p)
		}
	}
	if panics(t.TempDir()) {
		t.Error("a temp folder was refused")
	}
	// An in-memory SQLite database has no file: ":memory:" resolves to a relative name in the package folder, but nothing is written there. Each name is checked on its own.
	for _, p := range []string{":memory:", "file::memory:", "file::memory:?cache=shared", "file:x?mode=memory&cache=shared", "file:x?cache=shared&mode=memory"} {
		if panics(p) {
			t.Errorf("an in-memory database name was refused: %q", p)
		}
	}
	// A real file in the package folder must reach the check, however its name looks.
	for _, p := range []string{"x.db", "file:x.db", "file:x.db?mode=rwc", "file::memory:evil.db", "file:mode=memory.db", "file:x.db#mode=memory", "file:x.db?foo#mode=memory", "file:x.db?mode=memoryx"} {
		if !panics(p) {
			t.Errorf("a database FILE name in the package folder was not refused: %q", p)
		}
	}
	if panics(filepath.Join(filepath.Dir(root), "elsewhere")) {
		t.Error("a sibling of the module folder was refused")
	}
	defer func(f func() bool) { enabled = f }(enabled)
	enabled = func() bool { return false }
	if panics(root) {
		t.Error("the guard is not inert outside tests")
	}
}
