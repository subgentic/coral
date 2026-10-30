package testguard

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Both default ports are refused whatever the OS, and so are loopback names for them.
func TestBothDefaultPortsAreRefusedOnEveryOS(t *testing.T) {
	live := liveServerAddrs("", "", protectedDirs())
	for _, addr := range []string{"127.0.0.1:8420", "localhost:8420", "[::1]:8420", "127.0.0.1:8450", "LOCALHOST:8450", "[::1]:8450"} {
		assert.True(t, live[normalizeAddr(addr)], "%s is a live Coral's address", addr)
	}
	assert.False(t, live[normalizeAddr("127.0.0.1:54321")], "an ephemeral port is not")
	assert.False(t, live[normalizeAddr("example.com:8450")], "nor is another host")
}

// The live server's recorded address in the real data folder's lock file is refused too: a Coral on any port is the live one.
func TestThePortInTheRealLockFileIsRefused(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, lockFileName), []byte("4242\nhttp://localhost:9321\n0123456789abcdef0123456789abcdef\n"), 0o600))
	assert.Equal(t, []string{"9321"}, recordedPorts([]string{dir}))
	assert.Empty(t, recordedPorts([]string{t.TempDir()}), "no lock file")
	require.NoError(t, os.WriteFile(filepath.Join(dir, lockFileName), []byte("4242\n"), 0o600))
	assert.Empty(t, recordedPorts([]string{dir}), "no address in it")
	require.NoError(t, os.WriteFile(filepath.Join(dir, lockFileName), []byte("4242\nnot a url\n"), 0o600))
	assert.Empty(t, recordedPorts([]string{dir}), "a damaged address")
}

func TestThePanicNamesThePortAndSaysWhatToDo(t *testing.T) {
	live := liveServerAddrs("", "", protectedDirs())
	var msg string
	func() {
		defer func() { msg, _ = recover().(string) }()
		checkDial(live, "127.0.0.1:8450")
	}()
	require.NotEmpty(t, msg, "dialing the live port panics")
	assert.Contains(t, msg, "port 8450")
	assert.Contains(t, msg, "CORAL_URL must point at a scratch server")
	assert.Contains(t, msg, TestURLEnv)
}

// The rule, enforced: a client in a test binary with NO verifiable record and NO CORAL_URL goes to a default port, and the guard stops it before it connects. The client is a
// child process of this test binary (as the CLI tests run their programs), with CORAL_URL and CORAL_PORT cleared, dialing the default address of each OS.
func TestAClientWithNoRecordAndNoCoralURLIsRefusedAtADefaultPort(t *testing.T) {
	if os.Getenv("TESTGUARD_DEFAULT_PORT_CLIENT") != "" {
		return // the child's own run of this test does nothing: its client is the one below
	}
	for _, port := range []string{"8420", "8450"} {
		cmd := exec.Command(os.Args[0], "-test.run=^TestTheChildClientDialsTheDefaultPort$")
		cmd.Env = append(cleanedEnv(), "TESTGUARD_DEFAULT_PORT_CLIENT="+port)
		out, err := cmd.CombinedOutput()
		require.Error(t, err, "the dial must be refused, not made (port %s):\n%s", port, out)
		assert.Contains(t, string(out), "testguard: test dialed", port)
		assert.Contains(t, string(out), "port "+port, port)
	}
}

// TestTheChildClientDialsTheDefaultPort is the child's client; it does nothing in a normal run.
func TestTheChildClientDialsTheDefaultPort(t *testing.T) {
	port := os.Getenv("TESTGUARD_DEFAULT_PORT_CLIENT")
	if port == "" {
		t.Skip("run only as the child of TestAClientWithNoRecordAndNoCoralURLIsRefusedAtADefaultPort")
	}
	httpGet("http://localhost:" + port + "/api/health") // the guard panics here, before any connection is made
}

func cleanedEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); k == "CORAL_URL" || k == "CORAL_PORT" || k == TestURLEnv || k == "TESTGUARD_DEFAULT_PORT_CLIENT" {
			continue
		}
		env = append(env, kv)
	}
	return env
}

func httpGet(u string) {
	resp, err := http.Get(u)
	if err == nil {
		resp.Body.Close()
	}
}

// The live addresses include the port in a lock file in the real data folder (here a temp folder standing in for it, passed as liveServerAddrs's dirs).
func TestAPortRecordedInTheProtectedFolderIsRefused(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, lockFileName), []byte("4242\nhttp://127.0.0.1:9777\n"), 0o600))
	live := liveServerAddrs("", "", []string{dir})
	for _, host := range []string{"127.0.0.1", "localhost", "[::1]"} {
		assert.True(t, live[normalizeAddr(host+":9777")], host)
	}
	assert.False(t, liveServerAddrs("", "", []string{t.TempDir()})[normalizeAddr("127.0.0.1:9777")], "no record, not refused")
	assert.Panics(t, func() { checkDial(live, "127.0.0.1:9777") })
}

// A lock file that is not a regular file is skipped, never opened: a FIFO would block test init forever.
func TestALockFileThatIsNotARegularFileIsSkipped(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink(filepath.Join(dir, "elsewhere"), filepath.Join(dir, lockFileName)); err != nil {
		t.Skip("cannot make a link here:", err)
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, "elsewhere"), []byte("1\nhttp://127.0.0.1:9778\n"), 0o600))
	assert.Empty(t, recordedPorts([]string{dir}), "a link is not followed")
	big := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(big, lockFileName), []byte("1\nhttp://127.0.0.1:9779\n"+strings.Repeat("x", 5000)), 0o600))
	assert.Empty(t, recordedPorts([]string{big}), "over 4 KB")
}
