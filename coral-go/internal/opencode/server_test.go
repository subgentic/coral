package opencode

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMain makes this test binary the stand-in opencode when asked: `<binary> serve --hostname H --port P` listens on P, answers the messages route behind the password it was given in its environment,
// and writes the environment it saw to a file, so a test can read what the server was given.
func TestMain(m *testing.M) {
	if os.Getenv("CORAL_TEST_OPENCODE_STUB") == "1" {
		runStub()
		return
	}
	os.Exit(m.Run())
}

func runStub() {
	var port string
	for i, a := range os.Args {
		if a == "--port" && i+1 < len(os.Args) {
			port = os.Args[i+1]
		}
	}
	if out := os.Getenv("CORAL_TEST_OPENCODE_ENVFILE"); out != "" {
		seen := map[string]string{"args": strings.Join(os.Args[1:], " ")}
		for _, k := range []string{"OPENCODE_PASSWORD", "OPENCODE_DB", "OPENCODE_SERVER_URL", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "HOME"} {
			seen[k] = os.Getenv(k)
		}
		b, _ := json.Marshal(seen)
		_ = os.WriteFile(out, b, 0o600)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/session/ses_abc123/message", func(w http.ResponseWriter, r *http.Request) {
		if _, p, ok := r.BasicAuth(); !ok || p != os.Getenv("OPENCODE_PASSWORD") {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		fmt.Fprint(w, `{"items":[{"id":"m1","type":"assistant","text":"hello from the stand-in"}]}`)
	})
	l, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		os.Exit(3)
	}
	_ = http.Serve(l, mux)
}

func stubConfig(t *testing.T) (Config, string) {
	t.Helper()
	exe, err := os.Executable()
	require.NoError(t, err)
	t.Setenv("CORAL_TEST_OPENCODE_STUB", "1")
	envFile := filepath.Join(t.TempDir(), "env.json")
	t.Setenv("CORAL_TEST_OPENCODE_ENVFILE", envFile)
	return Config{Bin: exe, DataDir: filepath.Join(t.TempDir(), "opencode"), Ready: 10 * time.Second}, envFile
}

func TestTheServerRunsInCoralsOwnFolderBehindItsOwnPasswordAndIsStoppedByItsPid(t *testing.T) {
	// the person's own opencode settings are in this process's environment: none of them reach the server
	t.Setenv("OPENCODE_DB", "/home/person/.local/share/opencode/opencode.db")
	t.Setenv("OPENCODE_SERVER_URL", "http://127.0.0.1:4096")
	t.Setenv("XDG_DATA_HOME", "/home/person/.local/share")
	cfg, envFile := stubConfig(t)
	s, err := Start(context.Background(), cfg)
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

	rec, err := os.ReadFile(filepath.Join(cfg.DataDir, "server.json"))
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
	_, err = os.Stat(filepath.Join(cfg.DataDir, "server.json"))
	assert.True(t, os.IsNotExist(err), "and its pid file is gone")
}

func TestAServerThatExitsBeforeItAnswersIsAnErrorAndLeavesNothingRunning(t *testing.T) {
	cfg, _ := stubConfig(t)
	cfg.Args = func(int) []string { return []string{"serve", "--port", "1"} } // port 1 cannot be listened on: the stand-in exits
	cfg.Ready = 5 * time.Second
	_, err := Start(context.Background(), cfg)
	assert.ErrorContains(t, err, "exited before it answered")
	_, statErr := os.Stat(filepath.Join(cfg.DataDir, "server.json"))
	assert.True(t, os.IsNotExist(statErr))
}

func TestALeftOverPidThatIsAnotherProcessIsNeverSignalled(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "server.json")
	// this test process's own pid, with a port that is not in its command line: it is not the server that was recorded
	rec, _ := json.Marshal(pidRecord{PID: os.Getpid(), Port: 54321})
	require.NoError(t, os.WriteFile(f, rec, 0o600))
	stopLeftOver(f) // must not signal this process (it would end the test)
	_, err := os.Stat(f)
	assert.True(t, os.IsNotExist(err), "the record is dropped")
	assert.False(t, isOurServer(os.Getpid(), 54321))
	assert.False(t, isOurServer(0, 1) || isOurServer(1<<30, 1), "no such process")
	_ = strconv.Itoa
}

func TestThePasswordFileIsPrivateAndHoldsOnlyThePassword(t *testing.T) {
	cfg, envFile := stubConfig(t)
	s, err := Start(context.Background(), cfg)
	require.NoError(t, err)
	defer s.Stop()
	p, err := s.PasswordFile()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(cfg.DataDir, "password"), p)
	info, err := os.Stat(p)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
	b, _ := os.ReadFile(p)
	var seen map[string]string
	raw, _ := os.ReadFile(envFile)
	require.NoError(t, json.Unmarshal(raw, &seen))
	assert.Equal(t, seen["OPENCODE_PASSWORD"], string(b), "the same password the server was given")
}
