package routes

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/subgentic/coral/internal/sshprov"
)

// A failed restart of an upgrade says why and how to do it by hand (#12947, the Operator: the restart step "failed to restart" and nothing else). The person is shown a fixed sentence for what failed and a block
// of commands under the failed step, built only from this hub's own constants; the exit code, ssh's own words and the end of the far Coral's log go to the hub's log, never to the person (#12027).

// restartNote is what else is known about a failed restart, for the help under it.
type restartNote struct {
	noTmux       bool // the start failed because tmux is gone: the help also gives the way to start without it
	port         int  // the port the computer was set up on; 0 is the default
	holderPid    int  // the process found on port 8420, when known: the help gives the line that stops it
	stoppedAgain bool // the release was started but did not answer: it may still be starting, or it stopped again
}

func (n restartNote) portOrDefault() int {
	if sshprov.ValidPort(n.port) {
		return n.port
	}
	return sshprov.DefaultPort
}

func isConnectFailure(err error) bool {
	return errors.Is(err, sshprov.ErrConnect) || errors.Is(err, sshprov.ErrHostKey) || errors.Is(err, sshprov.ErrHostKeyChanged)
}

// stopFailureSentence is the fixed sentence for a stop that was not confirmed, or that could not be run: it says which way it was not confirmed (what the check found), because "did not stop, or that could
// not be checked" left the person guessing (#12947: a Coral of an earlier set-up lives in a tmux session and leaves no log and no pid file).
func stopFailureSentence(err error) string {
	var ns *sshprov.NotStoppedError
	switch {
	case errors.As(err, &ns):
		secs := int(sshprov.StopWait().Seconds())
		if secs < 1 {
			secs = 1
		}
		switch ns.Found {
		case sshprov.StillSession:
			return fmt.Sprintf("The running Coral on that computer did not stop within %d seconds: a tmux session named coral-server, the Coral of an earlier set-up, is still there. The new release was not started. Nothing was deleted.", secs)
		case sshprov.StillProcess:
			return fmt.Sprintf("The running Coral on that computer did not stop within %d seconds: a Coral process of this user, started from ~/.coral-server, is still running. The new release was not started. Nothing was deleted.", secs)
		}
		return "That computer could not say whether Coral had stopped (it has no ps that lists this user's processes), so the new release was not started. Nothing was deleted."
	case errors.Is(err, sshprov.ErrNotStopped):
		return "The running Coral on that computer did not stop, or that could not be checked, so the new release was not started. Nothing was deleted."
	case isConnectFailure(err):
		return connectSentence(err)
	}
	return "The running Coral on that computer could not be stopped or checked, so the new release was not started. Nothing was deleted."
}

// failRestart fails the step with the sentence, puts the help block under it and logs what is known: the error, the start's exit code, ssh's cleaned words, and the end of the far Coral's log (read only when
// the computer could be reached).
func (pr *Provisioner) failRestart(ctx context.Context, p *provisionPlan, step, sentence string, err error, note restartNote) {
	attrs := []any{"plan", p.ID, "step", step, "error", err.Error()}
	var se *sshprov.StartError
	if errors.As(err, &se) {
		attrs = append(attrs, "exit_code", se.ExitCode)
	}
	var ns *sshprov.NotStoppedError
	if errors.As(err, &ns) {
		attrs = append(attrs, "found", ns.Found) // 1 a tmux session, 2 a process, 3 it could not tell
	}
	var pe *sshprov.PortInUseError
	if errors.As(err, &pe) {
		attrs = append(attrs, "port_holder_pid", pe.Pid, "port_holder_command", pe.Command)
	}
	var ce *sshprov.ConnectError
	if errors.As(err, &ce) {
		attrs = append(attrs, "ssh", ce.Stderr)
	}
	if !isConnectFailure(err) {
		tctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if tail := pr.runner.LogTail(tctx, p.Target); tail != "" {
			attrs = append(attrs, "far_log", tail)
		}
		cancel()
	}
	slog.Warn("[provision] the upgrade did not restart", attrs...)
	p.setStepHelp(step, pr.restartHelp(note)) // before the failure is shown, so a page that sees it fail has the help too
	pr.fail(p, step, sentence)
}

// restartHelp is the block of lines under a failed restart: shell comments and commands the person can paste on the far computer. The paths are the provisioner's (sshprov.InstallDir) and the start line is
// the one the hub itself runs there (sshprov.CmdStartDaemon), with its detaching done by nohup and the PID written for the hub's own stop.
func (pr *Provisioner) restartHelp(note restartNote) []string {
	bin := "~/.coral-server/" + pr.version + "/root/coral"
	if !sshprov.ValidVersion(pr.version) {
		bin = `"$(ls -d ~/.coral-server/*/root/coral | sort -V | tail -1)"`
	}
	lines := []string{"# To see why, and to start it yourself, sign in to that computer and run these lines. Some may print nothing or an error (no tmux, no log yet): that is fine."}
	if note.stoppedAgain {
		lines = append(lines, "# It may still be starting, or it stopped again: the tail line below shows how far it got.")
	}
	lines = append(lines,
		"# What is running Coral there (a tmux session named coral-server is an earlier set-up; the ps lines are processes of this install, the number is the first column):",
		"tmux ls",
		`ps -u "$(id -u)" -o pid,args | grep -F "$HOME/.coral-server/" | grep -v grep`,
		"# Stop it: that tmux session, and the process the Hub recorded (check the number against the ps line above first: an old pid file can name another process):",
		"tmux kill-session -t coral-server",
		`kill "$(cat ~/.coral-server/coral.pid)"`,
		"# What Coral printed (there is no log until the Hub has started a release there):",
		"tail -n 40 ~/.coral-server/coral.log")
	if note.noTmux {
		lines = append(lines, "# tmux is not installed there: this forgets that agents ran in tmux (they will end whenever Coral restarts):", "rm ~/.coral-server/backend")
	}
	if note.holderPid > 0 {
		lines = append(lines, fmt.Sprintf("# Port %d is held by that process; stop it only if it is not something you need:", note.portOrDefault()), fmt.Sprintf("kill %d", note.holderPid))
	}
	lines = append(lines,
		"# Start the release:",
		"nohup "+bin+" --host 127.0.0.1 --port "+strconv.Itoa(note.portOrDefault())+` --no-browser --cloud-url off --backend "$(cat ~/.coral-server/backend 2>/dev/null || echo pty)" --home "$HOME/$(cat ~/.coral-server/datadir 2>/dev/null || echo .coral-server/data)" </dev/null >> ~/.coral-server/coral.log 2>&1 & echo $! > ~/.coral-server/coral.pid`,
		"# Then choose Upgrade here again: this hub finds the release already running and only checks it.")
	return lines
}
