package testguard

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Agent shells export the live server's address (CORAL_URL) and the live
// tmux server (TMUX), so a test run from one inherits both. In test binaries,
// init drops TMUX and TMUX_PANE, so nothing reaches the live tmux server
// through the default socket lookup, and makes http.DefaultTransport refuse
// connections to the live Coral server. Clients built on the default
// transport or a Clone of it are covered; a test talks to an httptest server
// instead.
func init() {
	// InTest, not enabled (InTestRun): package init runs before go test registers its flags, so InTestRun is false here in every test binary
	// and nothing would be guarded. What this does only protects (no TMUX, no dial to the live server), so a shipped binary that a launcher
	// starts with a -test.* argument loses nothing it should have (#214).
	if !InTest() {
		return
	}
	os.Unsetenv("TMUX")
	os.Unsetenv("TMUX_PANE")
	coralURL := os.Getenv("CORAL_URL")
	if os.Getenv(TestURLEnv) == "1" {
		coralURL = "" // a test harness pointed CORAL_URL at its own server
	}
	live := liveServerAddrs(coralURL, os.Getenv("CORAL_PORT"), protectedDirs())
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		dial := t.DialContext
		if dial == nil {
			dial = (&net.Dialer{}).DialContext
		}
		t.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			checkDial(live, addr)
			return dial(ctx, network, addr)
		}
	}
}

// TestURLEnv, set to "1" in a child process's environment, tells the guard
// that the child's CORAL_URL is the test's own httptest server, not the
// inherited live one. The default port stays refused.
const TestURLEnv = "CORAL_TESTGUARD_TEST_URL"

// defaultPorts are the ports a Coral server listens on unless told otherwise: 8450 on Windows (config.DefaultPort) and 8420 elsewhere. BOTH are refused on every OS: a
// test binary runs wherever it is built, and a CLI client that finds no verifiable record and no CORAL_URL goes to its OS's default, the live Coral's port. (This
// list once held 8420 only, so on Windows the live Coral at 8450 was never refused.) A test in the external test package asserts config.DefaultPort is in it.
var defaultPorts = []string{"8420", "8450"}

// DefaultPorts is the list above, for a test that checks it against config.DefaultPort (this package cannot import config: config links it).
func DefaultPorts() []string { return append([]string(nil), defaultPorts...) }

// lockFileName is the instance lock a running Coral server holds in its data folder, with its address in it (config.ServerLockFile; not imported, see above).
const lockFileName = "coral-server.lock"

// readRegularFile is the first max bytes of path, only if it is a regular file (Lstat, so a link or a FIFO named like the lock file is skipped, not opened: opening a FIFO
// would hang test init). nil for anything else, an empty file, or one over max.
func readRegularFile(path string, max int64) []byte {
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > max {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil || int64(len(b)) > max {
		return nil
	}
	return b
}

// recordedPorts are the ports of the addresses the live servers recorded in the real data folders' lock files (pid, url and instance id, one to a line): a Coral on a
// port other than the default is the live Coral too, and a test must not reach it by finding its record.
func recordedPorts(dirs []string) []string {
	var ports []string
	for _, dir := range dirs {
		b := readRegularFile(filepath.Join(dir, lockFileName), 4096)
		if b == nil {
			continue
		}
		lines := strings.Split(strings.TrimSpace(string(b)), "\n")
		if len(lines) < 2 {
			continue
		}
		if u, err := url.Parse(strings.TrimSpace(lines[1])); err == nil && u.Port() != "" {
			ports = append(ports, u.Port())
		}
	}
	return ports
}

// liveServerAddrs returns the host:port values a test must not dial: the
// inherited CORAL_URL and the loopback addresses on the default ports (both,
// on every OS), on CORAL_PORT and on the port the live server recorded in the
// real data folder's lock file.
func liveServerAddrs(coralURL, coralPort string, dirs []string) map[string]bool {
	addrs := map[string]bool{}
	ports := append([]string(nil), defaultPorts...)
	if coralPort != "" {
		ports = append(ports, coralPort)
	}
	ports = append(ports, recordedPorts(dirs)...)
	if u, err := url.Parse(strings.TrimSpace(coralURL)); err == nil && u.Host != "" {
		port := u.Port()
		if port == "" {
			port = map[string]string{"https": "443"}[u.Scheme]
			if port == "" {
				port = "80"
			}
		}
		addrs[normalizeAddr(net.JoinHostPort(u.Hostname(), port))] = true
		ports = append(ports, port)
	}
	for _, port := range ports {
		for _, host := range []string{"localhost", "127.0.0.1", "::1"} {
			addrs[normalizeAddr(net.JoinHostPort(host, port))] = true
		}
	}
	return addrs
}

func normalizeAddr(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return strings.ToLower(addr)
	}
	return net.JoinHostPort(strings.ToLower(host), port)
}

// checkDial panics when a test dials the live server. A panic, not an
// error: callers often turn a failed request into a quiet fallback, and this
// must stop the run.
func checkDial(live map[string]bool, addr string) {
	if live[normalizeAddr(addr)] {
		_, port, _ := net.SplitHostPort(normalizeAddr(addr))
		panic(fmt.Sprintf("testguard: test dialed %s: port %s is the live Coral's (a default port, 8420 or 8450, the port in CORAL_URL or CORAL_PORT, or the one in the real "+
			"data folder's lock file). A client that finds no verifiable record and no CORAL_URL goes to a default port: CORAL_URL must point at a scratch server "+
			"(an httptest server), and the child process of a harness that does that sets %s=1", addr, port, TestURLEnv))
	}
}
