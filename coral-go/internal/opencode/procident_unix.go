//go:build !windows

package opencode

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// isRecordedServer reports whether rec.PID is still the process that was recorded: its command line (ps) is exactly the recorded command and it began when the record says.
func isRecordedServer(rec pidRecord) bool {
	out, err := exec.Command("ps", "-o", "args=", "-p", strconv.Itoa(rec.PID)).Output()
	if err != nil || strings.TrimSpace(string(out)) != rec.Command {
		return false
	}
	return processStart(rec.PID) == rec.Started
}

// processStart is ps's start time of pid ("" where ps is not there or the process is not).
func processStart(pid int) string {
	out, err := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// processImage is only kept on Windows: ps's command line is what is compared here.
func processImage(int) string { return "" }

// endProcess asks the process to end (SIGTERM). It is only called for a pid isRecordedServer vouched for.
func endProcess(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Signal(syscall.SIGTERM)
	}
}

// askToEnd asks the server Coral started to end (SIGTERM); Server.Stop kills it if it does not within 3 s.
func askToEnd(s *Server) { _ = s.cmd.Process.Signal(syscall.SIGTERM) }

// identityComplete says what was read of a new process is enough to vouch for it later: on Unix its start time (the command is compared as text).
func identityComplete(started, _ string) bool { return started != "" }
