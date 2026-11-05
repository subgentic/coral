//go:build !windows

package heavy

import (
	"archive/tar"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13750: the wrapper end to end with in-memory pipes: header, archive, command, output, exit code. The header and the archive are hostile input.

const goodRun = "0123456789abcdef0123456789abcdef"

func stream(t *testing.T, h Header, files map[string]string) io.Reader {
	t.Helper()
	var b bytes.Buffer
	b.WriteString(Magic)
	raw, err := json.Marshal(h)
	require.NoError(t, err)
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(raw)))
	b.Write(n[:])
	b.Write(raw)
	tw := tar.NewWriter(&b)
	for name, body := range files {
		require.NoError(t, tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}))
		_, _ = tw.Write([]byte(body))
	}
	require.NoError(t, tw.Close())
	return &b
}

func cfgFor(t *testing.T) Config {
	t.Helper()
	root := filepath.Join(t.TempDir(), "coral-test")
	return Config{Root: root, Home: t.TempDir(), Shell: "/bin/sh", Now: time.Now}
}

func base() Header { return Header{Agent: "dev", Run: goodRun, Command: "echo hi", MaxSeconds: 30} }

func TestServeRunsTheCommandInTheExtractedFolderAndReturnsItsExitCodeInATrailer(t *testing.T) {
	cfg := cfgFor(t)
	h := base()
	h.Command = "cat a.txt; echo to-stderr >&2; pwd; exit 3"
	var out, errw bytes.Buffer
	code := Serve(t.Context(), stream(t, h, map[string]string{"a.txt": "from the archive\n"}), &out, &errw, cfg)
	assert.Equal(t, 3, code)
	assert.Contains(t, out.String(), "from the archive")
	assert.Contains(t, out.String(), filepath.Join("dev", goodRun), "it ran in the run folder")
	assert.Contains(t, errw.String(), "to-stderr")
	assert.Contains(t, errw.String(), Trailer+"exit 3", "the exit code comes back in a line of its own, so ssh's own 255 is told apart")
	_, err := os.Stat(filepath.Join(cfg.Root, "dev", goodRun))
	assert.True(t, os.IsNotExist(err), "the run folder is removed at the end")
}

func TestServeGivesTheCommandAnAllowlistedEnvironmentAndNothingOfTheWrappers(t *testing.T) {
	for k, v := range map[string]string{"GITHUB_TOKEN": "ghp_secret", "AWS_ACCESS_KEY_ID": "AKIA", "SSH_AUTH_SOCK": "/tmp/agent", "ANTHROPIC_API_KEY": "sk-x", "CORAL_URL": "http://127.0.0.1:8420", "NPM_TOKEN": "npm_x", "SSH_ORIGINAL_COMMAND": "touch /tmp/pwned-13750"} {
		t.Setenv(k, v)
	}
	cfg := cfgFor(t)
	h := base()
	h.Command = "env"
	h.Env = map[string]string{"CDP_FULL": "1"}
	var out, errw bytes.Buffer
	require.Equal(t, 0, Serve(t.Context(), stream(t, h, nil), &out, &errw, cfg), errw.String())
	env := out.String()
	for _, secret := range []string{"ghp_secret", "AKIA", "/tmp/agent", "sk-x", "8420", "npm_x", "touch /tmp/pwned-13750"} {
		assert.NotContains(t, env, secret)
	}
	for _, want := range []string{"HOME=" + cfg.Home, "CORAL_DATA_DIR=" + filepath.Join(cfg.Root, "dev", goodRun), "CORAL_TELEMETRY_DISABLED=1", "CDP_FULL=1", "LANG=", "TERM=", "PATH="} {
		assert.Contains(t, env, want)
	}
	assert.NoFileExists(t, "/tmp/pwned-13750", "SSH_ORIGINAL_COMMAND is never looked at")
}

func TestServeRefusesAHeaderThatIsNotWhatCoralMakes(t *testing.T) {
	cases := map[string]func(h *Header){
		"run id too short":  func(h *Header) { h.Run = "0123456789abcdef" },
		"run id upper case": func(h *Header) { h.Run = strings.ToUpper(goodRun) },
		"agent with slash":  func(h *Header) { h.Agent = "a/b" },
		"agent with dots":   func(h *Header) { h.Agent = ".." },
		"empty command":     func(h *Header) { h.Command = "" },
		"huge command":      func(h *Header) { h.Command = strings.Repeat("x", MaxCommand+1) },
		"nul in command":    func(h *Header) { h.Command = "echo a\x00b" },
		"env not on list":   func(h *Header) { h.Env = map[string]string{"GITHUB_TOKEN": "x"} },
		"env with newline":  func(h *Header) { h.Env = map[string]string{"CDP_FULL": "1\nPATH=/evil"} },
	}
	for name, mut := range cases {
		cfg := cfgFor(t)
		h := base()
		mut(&h)
		var out, errw bytes.Buffer
		code := Serve(t.Context(), stream(t, h, nil), &out, &errw, cfg)
		assert.Equal(t, ExitRefused, code, name)
		assert.Contains(t, errw.String(), Trailer+"refused", name)
		assert.Empty(t, out.String(), name+": nothing ran")
	}
	// not even the magic
	var out, errw bytes.Buffer
	assert.Equal(t, ExitRefused, Serve(t.Context(), strings.NewReader("hello\n"), &out, &errw, cfgFor(t)))
	// a header that claims more than the cap
	big := new(bytes.Buffer)
	big.WriteString(Magic)
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], MaxHeader+1)
	big.Write(n[:])
	assert.Equal(t, ExitRefused, Serve(t.Context(), big, &out, &errw, cfgFor(t)))
}

func TestServeNeverReusesARunFolderAndTheHeaderCanOnlyLowerTheCaps(t *testing.T) {
	cfg := cfgFor(t)
	_, err := MakeRunDir(cfg.Root, "dev", goodRun)
	require.NoError(t, err)
	var out, errw bytes.Buffer
	assert.Equal(t, ExitRefused, Serve(t.Context(), stream(t, base(), nil), &out, &errw, cfg), "the run folder is there: refused")
	assert.Contains(t, errw.String(), "exists")
	// a header asking for far more than the wrapper's caps is clamped, not obeyed: a file over the wrapper's own cap is refused
	cfg2 := cfgFor(t)
	cfg2.MaxBytes = 10
	h := base()
	h.Bytes = 1 << 40
	h.Files = 1 << 30
	errw.Reset()
	assert.Equal(t, ExitRefused, Serve(t.Context(), stream(t, h, map[string]string{"big": strings.Repeat("x", 100)}), &out, &errw, cfg2))
	assert.Contains(t, errw.String(), "cap")
}

func TestServeKillsTheWholeProcessGroupWhenTheConnectionDrops(t *testing.T) {
	cfg := cfgFor(t)
	pid := filepath.Join(t.TempDir(), "pid")
	h := base()
	h.Command = "sh -c 'echo $$ > " + pid + "; exec sleep 60' & while [ ! -s " + pid + " ]; do sleep 0.05; done; echo started; sleep 60"
	var errw bytes.Buffer
	gone := &failingWriter{after: 0} // the pipe back to ssh is broken: the first write fails
	start := time.Now()
	code := Serve(t.Context(), stream(t, h, nil), gone, &errw, cfg)
	assert.Less(t, time.Since(start), 20*time.Second)
	assert.NotEqual(t, 0, code)
	assert.Contains(t, errw.String(), Trailer+"killed")
	b, err := os.ReadFile(pid)
	require.NoError(t, err)
	p, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	require.Greater(t, p, 1)
	assert.Eventually(t, func() bool { return syscall.Kill(p, 0) != nil }, 5*time.Second, 50*time.Millisecond, "the background child of the command is gone too")
}

type failingWriter struct {
	after int
	n     int
}

func (f *failingWriter) Write(p []byte) (int, error) {
	f.n++
	if f.n > f.after {
		return 0, errors.New("broken pipe")
	}
	return len(p), nil
}

func TestServeStopsACommandAtItsTimeCapAndDoesNotLetItReadTheRestOfTheStream(t *testing.T) {
	cfg := cfgFor(t)
	h := base()
	h.Command = "sleep 60"
	h.MaxSeconds = 1
	var out, errw bytes.Buffer
	start := time.Now()
	code := Serve(t.Context(), stream(t, h, nil), &out, &errw, cfg)
	assert.Less(t, time.Since(start), 15*time.Second)
	assert.NotEqual(t, 0, code)
	assert.Contains(t, errw.String(), Trailer+"killed: time cap")
	// stdin of the command is nothing: a command that reads it ends at once
	h2 := base()
	h2.Command = "cat; echo done"
	out.Reset()
	errw.Reset()
	assert.Equal(t, 0, Serve(t.Context(), stream(t, h2, nil), &out, &errw, cfgFor(t)))
	assert.Contains(t, out.String(), "done")
}

func TestServeKillsTheCommandWhenTheConnectionEndsEvenIfItIsSilent(t *testing.T) {
	cfg := cfgFor(t)
	cfg.WatchStdin = true // what the wrapper does in production: the client keeps its end open for as long as the command runs
	h := base()
	h.Command = "sleep 60"
	h.MaxSeconds = 600
	pr, pw := io.Pipe()
	go func() {
		_, _ = io.Copy(pw, stream(t, h, nil))
		time.Sleep(400 * time.Millisecond)
		pw.Close() // the connection ends
	}()
	var out, errw bytes.Buffer
	start := time.Now()
	code := Serve(t.Context(), pr, &out, &errw, cfg)
	assert.Less(t, time.Since(start), 15*time.Second, "a silent command is ended when the connection is")
	assert.NotEqual(t, 0, code)
	assert.Contains(t, errw.String(), Trailer+"killed: connection dropped")
}
