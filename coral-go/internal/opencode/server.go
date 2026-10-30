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
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// ServeArgs are the arguments that start an opencode server for Coral on a loopback port (`opencode serve --hostname 127.0.0.1 --port <port>`, confirmed on v2.2.4 by Pi Tester, #11364); the password comes in
// OPENCODE_PASSWORD (the server has no password flag), never in the arguments.
func ServeArgs(port int) []string {
	return []string{"serve", "--hostname", "127.0.0.1", "--port", strconv.Itoa(port)}
}

// Config is how Coral runs its opencode server.
type Config struct {
	Bin     string // the opencode executable
	DataDir string // Coral's own folder for it (<Coral data dir>/opencode): its XDG folders, its database and its credentials live here and nowhere else
	Args    func(port int) []string
	Ready   time.Duration // how long to wait for the port to answer (default 20 s)
}

// Server is the one opencode server Coral runs for its data scope. It is never the person's own opencode background service: its database and its credentials are Coral's folder's, and it listens on a
// loopback port behind a password only Coral and the agents it launches know.
type Server struct {
	URL      string
	password string
	cmd      *exec.Cmd
	pidFile  string
	done     chan struct{}
}

// PasswordEnv is the environment entry an opencode client of this server needs (OPENCODE_PASSWORD=...): for the pane's environment, never for argv, a log or a file.
func (s *Server) PasswordEnv() string { return "OPENCODE_PASSWORD=" + s.password }

// PasswordFile writes the password to a private file in Coral's folder for the server (0600, the owner's alone) and returns its path: the agent's pane reads OPENCODE_PASSWORD from it, so the secret is never in
// the line typed into the pane. The file is written again at each start, with the new password.
func (s *Server) PasswordFile() (string, error) {
	p := filepath.Join(filepath.Dir(s.pidFile), "password")
	if err := os.WriteFile(p, []byte(s.password), 0o600); err != nil {
		return "", err
	}
	return p, nil
}

// Client is a client of the server.
func (s *Server) Client() (*Client, error) { return New(s.URL, s.password) }

// isolatedEnv is the environment of the server: the person's own environment, except every OPENCODE_ name (the person's own server, password and database settings) and the XDG folders, which are Coral's.
func isolatedEnv(inherited []string, dataDir, password string) []string {
	var env []string
	for _, kv := range inherited {
		name, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(strings.ToUpper(name), "OPENCODE_") || strings.HasPrefix(name, "XDG_") {
			continue
		}
		env = append(env, kv)
	}
	return append(env,
		"OPENCODE_PASSWORD="+password,
		"XDG_CONFIG_HOME="+filepath.Join(dataDir, "config"),
		"XDG_DATA_HOME="+filepath.Join(dataDir, "data"),
		"XDG_CACHE_HOME="+filepath.Join(dataDir, "cache"),
		"XDG_STATE_HOME="+filepath.Join(dataDir, "state"),
	)
}

func freeLoopbackPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

type pidRecord struct {
	PID  int `json:"pid"`
	Port int `json:"port"`
}

// Start runs the server and returns when its port answers. A server a previous Coral left running (its pid file) is stopped first, by that pid.
func Start(ctx context.Context, cfg Config) (*Server, error) {
	if cfg.Bin == "" || cfg.DataDir == "" {
		return nil, errors.New("opencode: a binary and a data folder are needed")
	}
	if cfg.Args == nil {
		cfg.Args = ServeArgs
	}
	if cfg.Ready <= 0 {
		cfg.Ready = 20 * time.Second
	}
	for _, d := range []string{"", "config", "data", "cache", "state"} {
		if err := os.MkdirAll(filepath.Join(cfg.DataDir, d), 0o700); err != nil {
			return nil, err
		}
	}
	pidFile := filepath.Join(cfg.DataDir, "server.json")
	stopLeftOver(pidFile)
	port, err := freeLoopbackPort()
	if err != nil {
		return nil, err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	password := hex.EncodeToString(raw)
	cmd := executil.Command(context.Background(), cfg.Bin, cfg.Args(port)...) // not ctx: the server outlives one request
	cmd.Dir = cfg.DataDir
	cmd.Env = isolatedEnv(os.Environ(), cfg.DataDir, password)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("opencode: could not start the server: %w", err)
	}
	s := &Server{URL: "http://127.0.0.1:" + strconv.Itoa(port), password: password, cmd: cmd, pidFile: pidFile, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(s.done) }()
	rec, _ := json.Marshal(pidRecord{PID: cmd.Process.Pid, Port: port}) // the pid and the port: never the password
	_ = os.WriteFile(pidFile, rec, 0o600)
	deadline := time.Now().Add(cfg.Ready)
	for {
		if c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 200*time.Millisecond); err == nil {
			c.Close()
			return s, nil
		}
		select {
		case <-s.done:
			_ = os.Remove(pidFile)
			return nil, errors.New("opencode: the server exited before it answered")
		case <-ctx.Done():
			s.Stop()
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			s.Stop()
			return nil, errors.New("opencode: the server did not answer in time")
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
	_ = os.Remove(s.pidFile)
}

// stopLeftOver stops the server a previous Coral recorded, by its pid, if that process is still there.
func stopLeftOver(pidFile string) {
	b, err := os.ReadFile(pidFile)
	if err != nil {
		return
	}
	defer os.Remove(pidFile)
	var rec pidRecord
	if json.Unmarshal(b, &rec) != nil || rec.PID <= 1 {
		return
	}
	if !isOurServer(rec.PID, rec.Port) {
		return // the pid is another process now (a restart reused it): never signalled
	}
	if p, err := os.FindProcess(rec.PID); err == nil {
		_ = p.Signal(syscall.SIGTERM)
	}
}

// isOurServer reports whether pid is still the server that was started on port: its command line (ps) names that port. Where ps is not there (Windows) it says no and nothing is signalled.
func isOurServer(pid, port int) bool {
	if runtime.GOOS == "windows" {
		return false
	}
	out, err := exec.Command("ps", "-o", "args=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	args := string(out)
	return strings.Contains(args, "serve") && strings.Contains(args, strconv.Itoa(port))
}
