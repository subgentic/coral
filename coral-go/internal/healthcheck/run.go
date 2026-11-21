package healthcheck

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/safego"
)

// Timeouts: the default and the most a check may ask for.
const (
	DefaultTimeout = 20 * time.Second
	MaxTimeout     = 60 * time.Second
)

// EnvInput is what a run's environment is built from.
type EnvInput struct {
	BoardURL string // loopback
	Board    string
	Token    string // the run's token (slice 3); empty until then
}

// Env builds a run's environment from nothing: a few plain variables and the three Coral ones. No secret key, owner stamp, Hub token, cloud URL or other CORAL_ variable, and none of the server's API-key
// variables, whatever the server's own environment holds. (The script still has the user's HOME files: approval is the control.)
func Env(in EnvInput) []string {
	var env []string
	for _, k := range []string{"PATH", "HOME", "TMPDIR", "TEMP", "LANG", "USERPROFILE", "SYSTEMROOT"} {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	add := func(k, v string) {
		if v != "" {
			env = append(env, k+"="+v)
		}
	}
	add("CORAL_BOARD_URL", in.BoardURL)
	add("CORAL_BOARD", in.Board)
	add("CORAL_CHECK_TOKEN", in.Token)
	return env
}

// Spec is one run.
type Spec struct {
	Path    string   // the snapshot, never the original
	Args    []string // exec'd as given: never a shell string
	Dir     string
	Env     []string
	Timeout time.Duration
}

// Result is what a run did.
type Result struct {
	Lines     []Line
	Bad       int
	ExitCode  int
	TimedOut  bool
	Truncated bool // it printed past the cap and was killed
	Err       error
}

// Failed says the run did not end well: it could not start, timed out or exited with a non-zero code. (Going past the output cap is not a failure of the check; it is cut.)
func (r Result) Failed() bool { return r.Err != nil || r.TimedOut || r.ExitCode != 0 }

// FailureReason is the fixed phrase for a failure: never the script's own words.
func (r Result) FailureReason() string {
	switch {
	case r.TimedOut:
		return "timeout"
	case r.Err != nil:
		return "could not start"
	case r.ExitCode != 0:
		return fmt.Sprintf("exit %d", r.ExitCode)
	}
	return ""
}

// Run runs the snapshot: exec, stdin closed, stderr dropped, its own process group (killed whole on timeout, on the output cap and when ctx ends), at most MaxBytes and MaxLines of output read.
func Run(ctx context.Context, sp Spec) Result {
	to := sp.Timeout
	if to <= 0 {
		to = DefaultTimeout
	}
	if to > MaxTimeout {
		to = MaxTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, to)
	defer cancel()

	cmd := exec.Command(sp.Path, sp.Args...)
	cmd.Dir = sp.Dir
	cmd.Env = append([]string{}, sp.Env...) // never nil: nil is the server's own environment
	prepare(cmd)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return Result{Err: err}
	}
	if err := cmd.Start(); err != nil {
		return Result{Err: err}
	}
	var res Result
	done := make(chan struct{})
	go func() {
		defer safego.Recover("healthcheck/run:108")
		select {
		case <-ctx.Done():
			killGroup(cmd)
			out.Close() // a child that left the group (setsid) still holds the pipe: closing it frees the read below
		case <-done:
		}
	}()

	var buf strings.Builder
	r := bufio.NewReaderSize(io.LimitReader(out, int64(MaxBytes)+1), 4096)
	n := 0
	for {
		line, rerr := r.ReadString('\n')
		buf.WriteString(line)
		n += len(line)
		if strings.TrimSpace(line) != "" && strings.Count(buf.String(), "\n") > MaxLines || n > MaxBytes {
			res.Truncated = true
			killGroup(cmd)
			out.Close()
			break
		}
		if rerr != nil {
			break
		}
	}
	werr := cmd.Wait()
	close(done)
	if ctx.Err() != nil && !res.Truncated {
		res.TimedOut = true
	}
	var ee *exec.ExitError
	switch {
	case werr == nil:
	case errors.As(werr, &ee):
		if !res.Truncated && !res.TimedOut {
			res.ExitCode = ee.ExitCode()
		}
	default:
		res.Err = werr
	}
	res.Lines, res.Bad = ParseOutput(buf.String())
	return res
}
