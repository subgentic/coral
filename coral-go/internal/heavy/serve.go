//go:build !windows

package heavy

import (
	"context"
	"errors"
	"fmt"
	"github.com/subgentic/coral/internal/safego"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Config is the wrapper's own settings: its caps are constants of its own and a header can only lower them.
type Config struct {
	Root       string // ~/coral-test
	Home       string
	Shell      string // /bin/sh
	Now        func() time.Time
	MaxFiles   int
	MaxBytes   int64
	MaxSeconds int
	WatchStdin bool // end the command when the connection (the stream's stdin) ends: on for the real wrapper
}

func (c *Config) defaults() {
	if c.Shell == "" {
		c.Shell = "/bin/sh"
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.MaxFiles <= 0 {
		c.MaxFiles = DefaultFiles
	}
	if c.MaxBytes <= 0 {
		c.MaxBytes = DefaultBytes
	}
	if c.MaxSeconds <= 0 {
		c.MaxSeconds = DefaultSeconds
	}
}

// guarded is the way back to ssh: a failed write is the connection dropping, which ends the command.
type guarded struct {
	w    io.Writer
	drop func()
	dead atomic.Bool
}

func (g *guarded) Write(p []byte) (int, error) {
	if g.dead.Load() {
		return len(p), nil // keep draining the pipe so the command is not stuck on it while it is being stopped
	}
	n, err := g.w.Write(p)
	if err != nil {
		g.dead.Store(true)
		g.drop()
		return len(p), nil
	}
	return n, nil
}

// Serve is the whole wrapper: read and check the header, make a fresh run folder, extract the archive into it, run the command there with the allowlisted environment, in its own process group that is killed when the
// connection ends, the time cap passes or the context ends, and say how it ended in a last line on errw. It returns the command's exit code (ExitRefused when it would not run it, ExitKilled when it stopped it). The run
// folder is removed at the end, and folders older than a day are removed at the start.
func Serve(ctx context.Context, in io.Reader, out, errw io.Writer, cfg Config) int {
	cfg.defaults()
	refuse := func(format string, a ...any) int {
		fmt.Fprintf(errw, "%srefused: %s\n", Trailer, fmt.Sprintf(format, a...))
		return ExitRefused
	}
	h, err := ReadHeader(in)
	if err != nil {
		return refuse("%v", err)
	}
	Janitor(cfg.Root, cfg.Now(), 24*time.Hour)
	dir, err := MakeRunDir(cfg.Root, h.Agent, h.Run)
	if err != nil {
		if errors.Is(err, ErrExists) {
			return refuse("the run folder exists")
		}
		return refuse("the run folder: %v", err)
	}
	defer func() { _ = RemoveRun(cfg.Root, h.Agent, h.Run) }()
	lim := Limits{Files: cfg.MaxFiles, Bytes: cfg.MaxBytes}
	if h.Files > 0 && h.Files < lim.Files {
		lim.Files = h.Files
	}
	if h.Bytes > 0 && h.Bytes < lim.Bytes {
		lim.Bytes = h.Bytes
	}
	if _, err := Extract(dir, in, lim); err != nil {
		if errors.Is(err, ErrTooBig) {
			return refuse("the archive is over the cap (%d files, %d bytes)", lim.Files, lim.Bytes)
		}
		return refuse("%v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o700); err != nil {
		return refuse("%v", err)
	}
	secs := cfg.MaxSeconds
	if h.MaxSeconds > 0 && h.MaxSeconds < secs {
		secs = h.MaxSeconds
	}

	cmd := exec.Command(cfg.Shell, "-c", h.Command)
	cmd.Dir = dir
	cmd.Env = Environ(cfg.Home, dir, h.Env)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var why atomic.Value
	var once sync.Once
	kill := func(reason string) {
		once.Do(func() {
			why.Store(reason)
			if cmd.Process != nil {
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) // the whole group: the command's background children too
			}
		})
	}
	outR, outW, err := os.Pipe() // our own pipes: the command's end is the only one open in this process after the start, and the wait for the output has a limit
	if err != nil {
		return refuse("%v", err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return refuse("%v", err)
	}
	cmd.Stdout, cmd.Stderr = outW, errW
	if err := cmd.Start(); err != nil {
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		return refuse("cannot start: %v", err)
	}
	outW.Close()
	errW.Close()
	timer := time.AfterFunc(time.Duration(secs)*time.Second, func() { kill("time cap") })
	defer timer.Stop()
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer safego.Recover("heavy/ctx")
		select {
		case <-ctx.Done():
			kill("stopped")
		case <-done:
		}
	}()
	if cfg.WatchStdin {
		go func() { // the client keeps its end open while the command runs: its end ending is the connection ending
			defer safego.Recover("heavy/stdin")
			_, _ = io.Copy(io.Discard, in)
			select {
			case <-done:
			default:
				kill("connection dropped")
			}
		}()
	}
	var copiers sync.WaitGroup
	copiers.Add(2)
	go func() {
		defer safego.Recover("heavy/errcopy")
		defer copiers.Done()
		_, _ = io.Copy(&guarded{w: errw, drop: func() { kill("connection dropped") }}, errR)
	}()
	go func() {
		defer safego.Recover("heavy/outcopy")
		defer copiers.Done()
		_, _ = io.Copy(&guarded{w: out, drop: func() { kill("connection dropped") }}, outR)
	}()
	werr := cmd.Wait() // the command itself has ended (or been killed)
	drained := make(chan struct{})
	go func() { defer safego.Recover("heavy/drain"); copiers.Wait(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(3 * time.Second): // something that left the group still holds the pipe: the output stops here
		outR.Close()
		errR.Close()
		<-drained
	}
	outR.Close()
	errR.Close()
	if r, ok := why.Load().(string); ok {
		fmt.Fprintf(errw, "%skilled: %s\n", Trailer, r)
		return ExitKilled
	}
	code := 0
	if werr != nil {
		var ee *exec.ExitError
		if errors.As(werr, &ee) {
			code = ee.ExitCode()
		} else {
			code = 1
		}
	}
	fmt.Fprintf(errw, "%sexit %d\n", Trailer, code)
	return code
}
