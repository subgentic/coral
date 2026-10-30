package opencode

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/subgentic/coral/internal/agentenv"
	"github.com/subgentic/coral/internal/executil"
	"github.com/subgentic/coral/internal/secfile"
)

// ServeArgs are the arguments that start an opencode server for Coral on a loopback port (`opencode serve --hostname 127.0.0.1 --port <port>`, confirmed on v2.2.4 by Pi Tester, #11364); the password comes in
// OPENCODE_PASSWORD (the server has no password flag), never in the arguments.
func ServeArgs(port int) []string {
	return []string{"serve", "--hostname", "127.0.0.1", "--port", strconv.Itoa(port)}
}

// Config is how Coral runs an opencode server.
type Config struct {
	Bin     string // the opencode executable, as it is exec'd
	DataDir string // Coral's own folder for opencode (<Coral data dir>/opencode): the XDG folders, its database and its credentials are here and nowhere else
	Args    func(port int) []string
	Model   string        // the model this server starts on, "provider/model" or "provider/model#variant" (a top-level "model" of a config file Coral writes for it); "" leaves opencode's own
	Ready   time.Duration // how long one attempt waits for the server to answer an authenticated call (default 20 s)

	pickPort func() (int, error) // a test's way to make a port race
}

// Server is one opencode server Coral runs for ONE agent: its own port and its own password, so what one agent's tools can reach is that agent's server and no other's (Security, #11364). Its database, and with it
// the sessions a resume needs, is Coral's folder's, shared by the servers of Coral's agents and never the person's own opencode or its background service.
type Server struct {
	URL      string
	password string
	cmd      *exec.Cmd
	dir      string // this server's own folder: its pid record and its password file
	done     chan struct{}
}

// keyRe is what an agent's key may be (its Coral session id): it names a folder.
var keyRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// PasswordEnv is the environment entry an opencode client of this server needs (OPENCODE_PASSWORD=...): for the pane's environment, never for argv, a log or a pid file.
func (s *Server) PasswordEnv() string { return "OPENCODE_PASSWORD=" + s.password }

// Client is a client of the server.
func (s *Server) Client() (*Client, error) { return New(s.URL, s.password) }

// ToolEnv is the environment opencode runs in for Coral, the server and anything that asks it about its own credentials (`opencode auth list`, `opencode auth login`): the one an agent gets (agentenv.Filter:
// Coral's own variables, tokens, keys and the identity of whatever started Coral are not passed on), without any OPENCODE_ or XDG_ name of the person's own or any CORAL_ one, plus Coral's XDG folders. Its
// credential store is Coral's, never the person's own opencode's: what is signed in there is what an agent's server has.
func ToolEnv(inherited []string, dataDir string) []string {
	var env []string
	for _, kv := range agentenv.Filter(inherited) {
		name, _, _ := strings.Cut(kv, "=")
		// nothing of Coral's reaches opencode either: agentenv.Filter keeps the CORAL_ variables an agent's tools read (CORAL_URL, CORAL_SESSION_NAME ...), which opencode has no use for
		if strings.HasPrefix(strings.ToUpper(name), "OPENCODE_") || strings.HasPrefix(name, "XDG_") || strings.HasPrefix(strings.ToUpper(name), "CORAL_") {
			continue
		}
		env = append(env, kv)
	}
	for _, kv := range XDGVars(dataDir) {
		env = append(env, kv[0]+"="+kv[1])
	}
	return env
}

// XDGVars are the folders opencode keeps its config, credentials, cache and state in when it runs for Coral: under Coral's own opencode folder, shared by the servers of Coral's agents and by nothing of the person's.
func XDGVars(dataDir string) [][2]string {
	return [][2]string{
		{"XDG_CONFIG_HOME", filepath.Join(dataDir, "config")},
		{"XDG_DATA_HOME", filepath.Join(dataDir, "data")},
		{"XDG_CACHE_HOME", filepath.Join(dataDir, "cache")},
		{"XDG_STATE_HOME", filepath.Join(dataDir, "state")},
	}
}

// serverEnv is the environment of one server: ToolEnv, the server's password, and its own config file when it has a model.
func serverEnv(inherited []string, dataDir, password, configFile string) []string {
	env := ToolEnv(inherited, dataDir)
	if configFile != "" {
		env = append(env, "OPENCODE_CONFIG="+configFile)
	}
	return append(env, "OPENCODE_PASSWORD="+password)
}

func freeLoopbackPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// modelRe is a model as opencode's config takes it: provider/model, with an optional #variant (the effort). It never holds a space, a quote or a control character, and never starts with a dash.
var modelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@\[\]+-]{0,63}/[A-Za-z0-9._:@\[\]+/-]{1,127}(#[A-Za-z0-9._-]{1,32})?$`)

// ValidModel reports whether m can be the model of a server's config.
func ValidModel(m string) bool { return modelRe.MatchString(m) }

// writeModelConfig writes the config file of one server (a top-level "model", nothing else) into its own folder, and returns its path; "" when there is no model to set. The file is the server's alone: the person's
// own opencode.json is never read or changed.
func writeModelConfig(dir, model string) (string, error) {
	if model == "" {
		return "", nil
	}
	if !ValidModel(model) {
		return "", fmt.Errorf("opencode: %q is not a model (provider/model, with an optional #variant)", model)
	}
	b, err := json.Marshal(map[string]string{"$schema": "https://opencode.ai/config.json", "model": model})
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, "opencode.json")
	return p, writePrivate(p, b)
}

// pidRecord is what Coral keeps of a server it started, to stop it after a crash: the pid and the port, the exact command it was started with and when the process began: never the password.
type pidRecord struct {
	PID     int    `json:"pid"`
	Port    int    `json:"port"`
	Command string `json:"command"` // the executable and arguments as exec'd, joined by one space
	Started string `json:"started"` // ps's start time of the process
}

// writePrivate writes data to path as a private file nobody can have planted a link at: a new file in the same folder created exclusively (no following of a link, mode 0600), then renamed over path.
func writePrivate(path string, data []byte) error {
	raw := make([]byte, 6)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	tmp := path + "." + hex.EncodeToString(raw) + ".tmp"
	f, err := secfile.OpenNoFollow(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// PasswordFile writes the password to a private file in this server's own folder (0600, the owner's alone) and returns its path: the agent's pane reads OPENCODE_PASSWORD from it, so the secret is never in the
// line typed into the pane.
func (s *Server) PasswordFile() (string, error) {
	p := filepath.Join(s.dir, "password")
	return p, writePrivate(p, []byte(s.password))
}

// startAttempts is how many ports one Start tries before it gives up.
const startAttempts = 3

// Start runs the opencode server of the agent key and returns when it answers an authenticated call. A server a previous Coral left running for that key is stopped first (the exact command and start time match
// required). A port another process took between the choosing and the listening is not trusted: the child must be alive and answer with this server's password, or the next port is tried.
func Start(ctx context.Context, cfg Config, key string) (*Server, error) {
	if cfg.Bin == "" || cfg.DataDir == "" || !keyRe.MatchString(key) {
		return nil, errors.New("opencode: a binary, a data folder and an agent key are needed")
	}
	if cfg.Args == nil {
		cfg.Args = ServeArgs
	}
	if cfg.Ready <= 0 {
		cfg.Ready = 20 * time.Second
	}
	if cfg.pickPort == nil {
		cfg.pickPort = freeLoopbackPort
	}
	dir := filepath.Join(cfg.DataDir, "servers", key)
	for _, d := range []string{cfg.DataDir, filepath.Join(cfg.DataDir, "servers"), dir, filepath.Join(cfg.DataDir, "config"), filepath.Join(cfg.DataDir, "data"), filepath.Join(cfg.DataDir, "cache"), filepath.Join(cfg.DataDir, "state")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	stopLeftOver(filepath.Join(dir, "server.json"))
	var lastErr error
	for attempt := 0; attempt < startAttempts; attempt++ {
		port, err := cfg.pickPort()
		if err != nil {
			return nil, err
		}
		s, err := startOn(ctx, cfg, dir, port)
		if err == nil {
			return s, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, lastErr
}

func startOn(ctx context.Context, cfg Config, dir string, port int) (*Server, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	password := hex.EncodeToString(raw)
	args := cfg.Args(port)
	cmd := executil.Command(context.Background(), cfg.Bin, args...) // not ctx: the server outlives one request
	cmd.Dir = cfg.DataDir
	configFile, err := writeModelConfig(dir, cfg.Model)
	if err != nil {
		return nil, err
	}
	cmd.Env = serverEnv(os.Environ(), cfg.DataDir, password, configFile)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("opencode: could not start the server: %w", err)
	}
	s := &Server{URL: "http://127.0.0.1:" + strconv.Itoa(port), password: password, cmd: cmd, dir: dir, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(s.done) }()
	pidFile := filepath.Join(dir, "server.json")
	rec, _ := json.Marshal(pidRecord{PID: cmd.Process.Pid, Port: port, Command: strings.Join(append([]string{cfg.Bin}, args...), " "), Started: processStart(cmd.Process.Pid)})
	_ = writePrivate(pidFile, rec)
	fail := func(err error) (*Server, error) {
		s.Stop()
		return nil, err
	}
	c, err := s.Client()
	if err != nil {
		return fail(err)
	}
	// The probe sends a WRONG password first: only a server that refuses it is one that wants a password, and the real one goes to the port only after that, so a stranger that won the port race never sees it.
	bad, err := New(s.URL, "not-"+password)
	if err != nil {
		return fail(err)
	}
	exited := func() bool {
		select {
		case <-s.done:
			return true
		default:
			return false
		}
	}
	deadline := time.Now().Add(cfg.Ready)
	for {
		select {
		case <-s.done:
			_ = os.Remove(pidFile)
			return nil, errors.New("opencode: the server exited before it answered")
		case <-ctx.Done():
			return fail(ctx.Err())
		default:
		}
		actx, cancel := context.WithTimeout(ctx, time.Second)
		status, err := bad.ping(actx)
		cancel()
		switch {
		case err == nil && status == 200:
			return fail(errors.New("opencode: another server answers on this port, one that asks for no password"))
		case err == nil && (status == 401 || status == 403):
			// It wants a password. Now the real one: the child must still be running (one that could not listen has exited) and must take it.
			rctx, rcancel := context.WithTimeout(ctx, time.Second)
			rstatus, rerr := c.ping(rctx)
			rcancel()
			if exited() {
				_ = os.Remove(pidFile)
				return nil, errors.New("opencode: the server exited before it answered")
			}
			if rerr == nil && rstatus == 200 {
				return s, nil
			}
			return fail(errors.New("opencode: another server answers on this port"))
		}
		if time.Now().After(deadline) {
			return fail(errors.New("opencode: the server did not answer in time"))
		}
		select {
		case <-s.done:
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// Stop ends the server Coral started, by its own process: never by name.
func (s *Server) Stop() {
	if s == nil || s.cmd == nil || s.cmd.Process == nil {
		return
	}
	_ = s.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-s.done:
	case <-time.After(3 * time.Second):
		_ = s.cmd.Process.Kill()
		<-s.done
	}
	_ = os.Remove(filepath.Join(s.dir, "server.json"))
	_ = os.Remove(filepath.Join(s.dir, "password")) // a dead server's password is not kept
}

// stopLeftOver stops the server a previous Coral recorded, if that process is still there: its pid must show, by ps, the exact command that was recorded and the start time that was recorded. A pid that is
// another process now (a restart reused it) is never signalled.
func stopLeftOver(pidFile string) {
	b, err := os.ReadFile(pidFile)
	if err != nil {
		return
	}
	defer os.Remove(pidFile)
	var rec pidRecord
	if json.Unmarshal(b, &rec) != nil || rec.PID <= 1 || rec.Command == "" || rec.Started == "" {
		return
	}
	if !isRecordedServer(rec) {
		return
	}
	if p, err := os.FindProcess(rec.PID); err == nil {
		_ = p.Signal(syscall.SIGTERM)
	}
}

// isRecordedServer reports whether rec.PID is still the process that was recorded: its command line (ps) is exactly the recorded command and it began when the record says. Where ps is not there (Windows) it
// says no and nothing is signalled.
func isRecordedServer(rec pidRecord) bool {
	if runtime.GOOS == "windows" {
		return false
	}
	out, err := exec.Command("ps", "-o", "args=", "-p", strconv.Itoa(rec.PID)).Output()
	if err != nil || strings.TrimSpace(string(out)) != rec.Command {
		return false
	}
	return processStart(rec.PID) == rec.Started
}

// processStart is ps's start time of pid ("" where ps is not there or the process is not).
func processStart(pid int) string {
	if runtime.GOOS == "windows" {
		return ""
	}
	out, err := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
