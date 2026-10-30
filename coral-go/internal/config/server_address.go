package config

import (
	"encoding/json"
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

// healthTimeout bounds the one question VerifiedServer asks.
const healthTimeout = 2 * time.Second

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
	client := &http.Client{Timeout: healthTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(strings.TrimRight(addr, "/") + "/api/health")
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var h struct {
		Status     string `json:"status"`
		Version    string `json:"version"`
		InstanceID string `json:"instance_id"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&h); err != nil || h.Status != "ok" {
		return ""
	}
	if id != "" {
		if h.InstanceID != id {
			return ""
		}
	} else if h.Version == "" {
		return ""
	}
	return addr
}

// LocalServerURL is where a command typed with no CORAL_URL, CORAL_HOST or CORAL_PORT finds this computer's Coral: the address the server for the data folder
// (CORAL_DATA_DIR, else ~/.coral) recorded in its lock file, so a Coral on another port is found, and only then the platform's default port (8450 on Windows, 8420
// elsewhere). The recorded address is only ever a loopback one (RecordedServer), so the command never sends its token anywhere else.
func LocalServerURL() string {
	if addr := VerifiedServer(ResolveCoralDir("")); addr != "" {
		return strings.TrimRight(addr, "/")
	}
	return "http://localhost:" + strconv.Itoa(DefaultPort)
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
