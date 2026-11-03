package tmux

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/subgentic/coral/internal/procspawn"
	"github.com/subgentic/coral/internal/safego"
)

// startsServer says the tmux command may start the tmux server (no server yet: new-session and start-server do), past the socket arguments.
func startsServer(args []string) bool {
	sub, _ := tmuxCommandName(args)
	return sub == "new-session" || sub == "start-server"
}

// outputDisclaimedIf is outputDisclaimed for a command that may start the server, and ok false for any other.
func outputDisclaimedIf(starts bool, ctx context.Context, bin string, args, env []string) ([]byte, error, bool) {
	if !starts {
		return nil, nil, false
	}
	return outputDisclaimed(ctx, bin, args, env)
}

// outputDisclaimed runs a tmux command that may start the server so that macOS does not count the server (and every agent started under it) as part of Coral.app: a GUI program
// that is part of Coral.app and exits made loginwindow force-quit all of them at once (#12836, see procspawn). ok is false when there is nothing to do differently (not macOS, or the
// call is not there), and the caller runs the command as usual.
func outputDisclaimed(ctx context.Context, bin string, args, env []string) (out []byte, err error, ok bool) {
	if !procspawn.Supported() {
		return nil, nil, false
	}
	outR, outW, perr := os.Pipe()
	if perr != nil {
		return nil, nil, false
	}
	errR, errW, perr := os.Pipe()
	if perr != nil {
		outR.Close()
		outW.Close()
		return nil, nil, false
	}
	pid, serr := procspawn.Spawn(bin, append([]string{bin}, args...), procspawn.Options{Env: env, Stdout: outW, Stderr: errW})
	outW.Close()
	errW.Close()
	if serr != nil {
		outR.Close()
		errR.Close()
		return nil, nil, false // not spawned this way (no such program as spawn sees it, no call here): the plain start runs it and reports in its own words
	}
	var stdout, stderr bytes.Buffer
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer safego.Recover("tmux disclaimed stdout copy")
		defer wg.Done()
		_, _ = io.Copy(&stdout, outR)
		outR.Close()
	}()
	go func() {
		defer safego.Recover("tmux disclaimed stderr copy")
		defer wg.Done()
		_, _ = io.Copy(&stderr, errR)
		errR.Close()
	}()
	p, _ := os.FindProcess(pid)
	waited := make(chan struct{})
	go func() {
		defer safego.Recover("tmux disclaimed kill on cancel")
		select {
		case <-ctx.Done():
			_ = p.Kill()
		case <-waited:
		}
	}()
	st, werr := p.Wait()
	close(waited)
	wg.Wait() // the daemonized server does not keep the pipes: tmux closes them when it detaches
	if werr != nil {
		return stdout.Bytes(), werr, true
	}
	if ctx.Err() != nil {
		return stdout.Bytes(), ctx.Err(), true
	}
	if !st.Success() {
		return stdout.Bytes(), &exec.ExitError{ProcessState: st, Stderr: stderr.Bytes()}, true
	}
	return stdout.Bytes(), nil, true
}
