//go:build !windows

package heavy

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func cfgForClient(t *testing.T) Config {
	t.Helper()
	return Config{Root: filepath.Join(t.TempDir(), "coral-test"), Home: t.TempDir(), Shell: "/bin/sh", Now: time.Now, WatchStdin: true}
}

// inProcessTransport is ssh without ssh: the client's stream goes into the real wrapper (Serve) through pipes.
func inProcessTransport(cfg Config) Transport {
	return func(ctx context.Context) (Conn, error) {
		inR, inW := io.Pipe()
		outR, outW := io.Pipe()
		errR, errW := io.Pipe()
		done := make(chan struct{})
		go func() {
			Serve(ctx, inR, outW, errW, cfg)
			outW.Close()
			errW.Close()
			close(done)
		}()
		return Conn{Stdin: inW, Stdout: outR, Stderr: errR, Wait: func() error { <-done; return nil }}, nil
	}
}

func failingTransport() Transport {
	return func(ctx context.Context) (Conn, error) {
		outR, outW := io.Pipe()
		errR, errW := io.Pipe()
		go func() {
			errW.Write([]byte("ssh: Could not resolve hostname coral-heavy-mini\n"))
			outW.Close()
			errW.Close()
		}()
		return Conn{Stdin: nopWriteCloser{io.Discard}, Stdout: outR, Stderr: errR, Wait: func() error { return errors.New("exit status 255") }}, nil
	}
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }

// Everything together without ssh: the client's stream goes into the real wrapper (Serve) through pipes, and the command's output and exit code come back.
func TestAWorktreeIsSentRunAndItsExitCodeAndOutputComeBack(t *testing.T) {
	dir := gitRepo(t)
	put(t, dir, "hello.txt", "hello from the worktree\n")
	put(t, dir, "sub/run.sh", "#!/bin/sh\ncat ../hello.txt; echo cwd=$(basename $(pwd)); exit 4\n")
	require.NoError(t, os.Chmod(filepath.Join(dir, "sub/run.sh"), 0o755))
	put(t, dir, ".env", "SECRET=1")
	cfg := cfgForClient(t)
	var out, errw bytes.Buffer
	code, err := Run(context.Background(), RunOptions{
		Worktree: dir, Subdir: "sub", Command: "sh run.sh; ls ../.env 2>/dev/null || echo no-env-file", Agent: "Lead Developer", MaxSeconds: 60,
		Env: map[string]string{"CDP_FULL": "1"}, Limits: ClientLimits{Files: 100, Bytes: 1 << 20}, Out: &out, Err: &errw,
		Transport: inProcessTransport(cfg),
	})
	require.NoError(t, err, errw.String())
	assert.Equal(t, 0, code, "the last command's exit (the ls fallback): the run itself worked")
	assert.Contains(t, out.String(), "hello from the worktree")
	assert.Contains(t, out.String(), "cwd=sub", "it ran in the same subfolder")
	assert.Contains(t, out.String(), "no-env-file", "the secret-looking file was not sent")
	assert.NotContains(t, errw.String(), Trailer, "the trailer is taken out of what the person sees")
	assert.Contains(t, errw.String(), ".env: a name that looks like a secret", "and what was left out is said")
	// the exit code of the command comes back
	out.Reset()
	errw.Reset()
	code, err = Run(context.Background(), RunOptions{Worktree: dir, Subdir: "sub", Command: "sh run.sh", Agent: "x", MaxSeconds: 60, Limits: ClientLimits{Files: 100, Bytes: 1 << 20}, Out: &out, Err: &errw, Transport: inProcessTransport(cfg)})
	require.NoError(t, err)
	assert.Equal(t, 4, code)
	// a transport that fails before the wrapper says anything is told apart
	code, err = Run(context.Background(), RunOptions{Worktree: dir, Command: "true", Agent: "x", MaxSeconds: 5, Limits: ClientLimits{Files: 100, Bytes: 1 << 20}, Out: &out, Err: &errw, Transport: failingTransport()})
	require.NoError(t, err)
	assert.Equal(t, ExitConnection, code)
	assert.Contains(t, errw.String(), "connection")
}
