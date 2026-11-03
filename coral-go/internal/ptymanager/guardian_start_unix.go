//go:build !windows

package ptymanager

import (
	"io"
	"os"
	"os/exec"
	"syscall"

	"github.com/subgentic/coral/internal/procspawn"
)

// guardianName is the guardian's argv[0], so it is named in a process list.
const guardianName = "coral pty-guardian"

// guardianProc is a running guardian: its process, and the wait for its end (once).
type guardianProc struct {
	Process *os.Process
	wait    func() error
}

// Wait waits for the guardian to end.
func (g *guardianProc) Wait() error { return g.wait() }

// startGuardianProcess runs exe in guardian mode: in a session of its own (a signal to Coral's group or a closed terminal does not reach it), with only the marker in its environment, no output,
// and a pipe from us as its stdin. On macOS it is started so that it is not part of Coral.app: the terminals it guards (and the shell of each) are its children, and macOS must not take
// them down with the app (#12836, see procspawn).
func startGuardianProcess(exe string) (*guardianProc, io.WriteCloser, error) {
	env := []string{guardianEnv + "=1"}
	if procspawn.Supported() {
		r, w, err := os.Pipe()
		if err == nil {
			pid, serr := procspawn.Spawn(exe, []string{guardianName, guardianArg}, procspawn.Options{Env: env, Stdin: r, Setsid: true})
			r.Close()
			if serr == nil {
				p, ferr := os.FindProcess(pid)
				if ferr != nil {
					w.Close()
					return nil, nil, ferr
				}
				return &guardianProc{Process: p, wait: func() error { _, err := p.Wait(); return err }}, w, nil
			}
			w.Close() // not spawned that way: the plain start below
		}
	}
	c := exec.Command(exe, guardianArg)
	c.Args[0] = guardianName // what ps shows: not a second, unexplained "coral"
	c.Env = env
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	in, err := c.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := c.Start(); err != nil {
		return nil, nil, err
	}
	return &guardianProc{Process: c.Process, wait: c.Wait}, in, nil
}
