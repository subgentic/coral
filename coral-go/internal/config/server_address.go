package config

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ServerLockFile is the instance lock a running Coral server holds in its data folder. Once it listens, the server records
// "<pid>\n<url>\n" in it, and empties it again when it stops (#235).
const ServerLockFile = "coral-server.lock"

// RecordedServer is the PID and address the Coral server for coralDir recorded in its lock file: 0 and "" when there is none or it
// can't be read. url is only ever an http(s) address on this computer (localhost or a loopback IP), so a command that finds it
// never sends its token anywhere else.
func RecordedServer(coralDir string) (pid int, addr string) {
	pid, addr, _ = RecordedInstance(coralDir)
	return pid, addr
}

// RecordedInstance is RecordedServer and the server's instance id (the record's third line; "" in a record an older server wrote, or a damaged one).
func RecordedInstance(coralDir string) (pid int, addr, id string) {
	b, err := os.ReadFile(filepath.Join(coralDir, ServerLockFile))
	if err != nil || len(b) > 4096 {
		return 0, "", ""
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if n, err := strconv.Atoi(strings.TrimSpace(lines[0])); err == nil && n > 0 {
		pid = n
	}
	if len(lines) > 1 {
		if u := strings.TrimSpace(lines[1]); localServerURL(u) {
			addr = u
		}
	}
	if len(lines) > 2 {
		if v := strings.TrimSpace(lines[2]); instanceIDShape.MatchString(v) {
			id = v
		}
	}
	return pid, addr, id
}

// instanceIDShape is what a server's instance id looks like: 32 lower-case hex digits.
var instanceIDShape = regexp.MustCompile(`^[0-9a-f]{32}$`)

// healthTimeout bounds the one question the commands (coral-board, coral) ask before they go to a recorded address. It is 5 s: the first connection a process makes to a loopback
// address can be slow on a busy or cold Windows machine (a hosted runner's first connect was taken for a dead record at 2 s). A recorded address that does not answer is an ERROR
// (since #246 never a fall back to the default port), and a dead record on loopback is refused at once, so only an address that swallows the request waits this long. No credential is
// sent before the answer is checked. A variable so a test can shorten it.
var healthTimeout = 5 * time.Second

// quickHealthTimeout is the same question for LocalServerURL, which the hooks and the agent tools call on every run: a hung server must not hold each of them for 5 s.
var quickHealthTimeout = 2 * time.Second

// defaultServerURL is where a command goes when no usable record names the Coral: this platform's default port. A variable so a test can point it at a scratch server.
var defaultServerURL = "http://localhost:" + strconv.Itoa(DefaultPort)

// plainTransport is http.DefaultTransport as this package found it at start-up. A command may later replace the default transport with one that signs its requests
// (coral-board does, before it runs a command), and the health question must be asked with the plain one, whatever was installed since.
var plainTransport, _ = http.DefaultTransport.(*http.Transport)

type healthAnswer struct {
	Status     string `json:"status"`
	Version    string `json:"version"`
	InstanceID string `json:"instance_id"`
}

// askHealth asks addr (a loopback address) /api/health and returns the answer if it is a 200 JSON one. It sends no credential and follows no redirect. For an https
// address the certificate is not verified: a Coral with TLS on a non-default port uses a certificate of its own that nothing here could check, and nothing is sent that
// a listener could misuse; the instance id in the answer, not the certificate, is the identity (a record without one is the weaker check VerifiedServer says).
func askHealth(addr string, timeout time.Duration) (healthAnswer, error) {
	var h healthAnswer
	if plainTransport == nil {
		return h, errors.New("no HTTP transport")
	}
	tr := plainTransport.Clone() // keeps the default transport's dial hook (the tests' guard against reaching a live Coral)
	if skipsCertificateCheck(addr) {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // loopback only, no credential sent, identity is the instance id
	}
	client := &http.Client{Timeout: timeout, Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer tr.CloseIdleConnections()
	resp, err := client.Get(strings.TrimRight(addr, "/") + "/api/health")
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return h, fmt.Errorf("timed out after %s", timeout)
		}
		return h, errors.New("could not connect") // the kind only: no address, query or error text

	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return h, fmt.Errorf("answered %d, not 200", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&h); err != nil {
		return h, errors.New("the answer is not JSON")
	}
	if h.Status != "ok" {
		return h, errors.New("the status in the answer is not ok")
	}
	return h, nil
}

// verifyAddr asks addr who it is and checks the answer against the record's instance id (or, for a record without one, a version): nil if it is that Coral, else why not.
func verifyAddr(addr, id string, timeout time.Duration) error {
	h, err := askHealth(addr, timeout)
	if err != nil {
		return err
	}
	return h.mismatch(id)
}

// skipsCertificateCheck is whether askHealth leaves the certificate unverified for addr: only an https address on this computer (localhost or a loopback IP).
func skipsCertificateCheck(addr string) bool {
	u, err := url.Parse(addr)
	return err == nil && u.Scheme == "https" && localServerURL(addr)
}

// mismatch is nil when h is the answer of the Coral a record names: its instance id, or for a record without one (an older server wrote it) a version; else why not.
func (h healthAnswer) mismatch(id string) error {
	if id != "" {
		if h.InstanceID != id {
			return errors.New("the instance id in the answer is not the recorded one")
		}
		return nil
	}
	if h.Version == "" {
		return errors.New("the answer has no version")
	}
	return nil
}

// VerifiedServer is the address of the Coral server recorded for coralDir, only if that record is still true: the recorded process is running, and the address answers
// /api/health as THAT server (the instance id in the answer is the one in the record). A record left by a server that crashed names a port something else may hold by now,
// and a command that sent its credentials there would hand them to it: so the question is asked first, with no credential, and "" is returned unless it is answered as
// this Coral. A record without an instance id (an older server wrote it) needs a live process and a Coral-shaped health answer (status ok and a version): weaker, and
// said so here, until that server is restarted.
func VerifiedServer(coralDir string) string {
	pid, addr, id := RecordedInstance(coralDir)
	if addr == "" || !processAlive(pid) {
		return ""
	}
	if verifyAddr(addr, id, healthTimeout) == nil {
		return addr
	}
	return ""
}

// ResolveServer is where a command typed with nothing saying where Coral is reaches it: ResolveServerAt with this platform's default port as the fallback.
func ResolveServer(coralDir string) (string, error) {
	return ResolveServerAt(coralDir, defaultServerURL)
}

// ResolveServerAt is the address for coralDir's Coral, or an error that says what to do; it never hands back an address that has not answered as a Coral.
//   - a record whose process runs and whose address answers as that Coral: the recorded address;
//   - a record whose process runs but whose address does not answer as it: an ERROR, not fallback. The Coral is up somewhere, and the default port may be something else;
//   - no record, or one whose process is gone: fallback, but only if it answers /api/health with status ok and a version (no credential is sent to find out); else an error.
func ResolveServerAt(coralDir, fallback string) (string, error) {
	if addr, err := ResolveRecorded(coralDir); addr != "" || err != nil {
		return addr, err
	}
	h, err := askHealth(fallback, healthTimeout)
	if err == nil && h.Version == "" {
		err = errors.New("the answer has no version")
	}
	if err == nil {
		return fallback, nil
	}
	return "", fmt.Errorf("no Coral answered at %s (%v). Start Coral, or set CORAL_URL to the address of the one you mean", fallback, err)
}

// ResolveRecorded is the record half of ResolveServerAt: the verified recorded address; an error when a live process recorded one that does not answer as that Coral; and
// "" with no error when there is no usable record (the caller then has its own default, and decides whether to ask it). The commands that prove the server themselves before
// they send a credential (coral's CLI token hello) use this and never ask the default port.
func ResolveRecorded(coralDir string) (string, error) {
	pid, addr, id := RecordedInstance(coralDir)
	if addr == "" || !processAlive(pid) {
		return "", nil
	}
	if err := verifyAddr(addr, id, healthTimeout); err != nil {
		return "", unverifiedError(pid, addr, err)
	}
	return addr, nil
}

// unverifiedError is the error for a live process whose recorded address did not answer as that Coral; why is the kind of failure only.
func unverifiedError(pid int, addr string, why error) error {
	return fmt.Errorf("Coral is running on this data folder (PID %d) and recorded %s, but that address did not answer as this Coral (%v). "+
		"Restart Coral, or set CORAL_URL to its address. If Coral is not running, start it (the record may name a process id that something else now uses)", pid, addr, why)
}

// LocalServer is where a command typed with no CORAL_URL, CORAL_HOST or CORAL_PORT finds this computer's Coral: ResolveServer for the data folder (CORAL_DATA_DIR, else ~/.coral).
// The recorded address is only ever a loopback one (RecordedServer), so the command never sends its token anywhere else.
func LocalServer() (string, error) { return ResolveServer(ResolveCoralDir("")) }

// LocalServerURL is where a program that has no way to report an error (the agent tools, the hooks: it runs when they start, even in a test binary) finds this computer's Coral:
// the verified recorded address; "" and a line on stderr when a live process recorded one that does not answer as that Coral (not the default port: the Coral is up somewhere
// else); otherwise the platform's default address, NOT asked whether a Coral answers there. The commands a person types (coral-board, coral) use LocalServer and ResolveServerAt,
// which do ask before they send a credential.
func LocalServerURL() string {
	dir := ResolveCoralDir("")
	pid, addr, id := RecordedInstance(dir)
	if addr != "" && processAlive(pid) {
		err := verifyAddr(addr, id, quickHealthTimeout)
		if err == nil {
			return strings.TrimRight(addr, "/")
		}
		fmt.Fprintf(os.Stderr, "Error: %v\n", unverifiedError(pid, addr, err))
		return ""
	}
	return defaultServerURL
}

// localServerURL: an http(s) URL with no credentials, path or query, whose host is localhost or a loopback IP.
func localServerURL(u string) bool {
	p, err := url.Parse(u)
	if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.User != nil || p.Port() == "" ||
		(p.Path != "" && p.Path != "/") || p.RawQuery != "" || p.Fragment != "" {
		return false
	}
	if strings.EqualFold(p.Hostname(), "localhost") {
		return true
	}
	ip := net.ParseIP(p.Hostname())
	return ip != nil && ip.IsLoopback()
}

// ApplyPortFlag puts a --port flag into cfg (coral and launch-coral). A port that was not given leaves the default (or CORAL_PORT) as it is; one that was given replaces it, and an explicit 0 means
// "any free port", which startup.Start binds and reports in cfg.Port: 0 is no longer taken for "not given" (a test, or a person, asking for port 0 got the default port,
// which on Windows is the live Coral's 8450). A port outside 0-65535 is refused.
func ApplyPortFlag(cfg *Config, port int, given bool) error {
	if !given {
		return nil
	}
	if port < 0 || port > 65535 {
		return fmt.Errorf("--port %d is not a port: use 0 for any free port, or 1-65535", port)
	}
	cfg.Port = port
	return nil
}
