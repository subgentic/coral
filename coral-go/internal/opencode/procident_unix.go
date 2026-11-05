//go:build !windows

package opencode

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// isRecordedServer reports whether rec.PID is still the process that was recorded: its command line (ps) is exactly the recorded command and it began when the record says.
func isRecordedServer(rec pidRecord) bool {
	out, err := exec.Command("ps", "-o", "args=", "-p", strconv.Itoa(rec.PID)).Output()
	if err != nil || strings.TrimSpace(string(out)) != rec.Command {
		return false
	}
	return sameStart(processStart(rec.PID), rec.Started)
}

const (
	psStartLayout = "Mon Jan _2 15:04:05 2006"
	startSlack    = 2 * time.Second
)

// sameStart is whether two ps start times name one process start. lstart has whole-second resolution and on Linux it is the boot time plus start ticks, so two reads of one
// process under load can be a second apart (#13412, as #13409): up to startSlack apart is the same process, a recycled pid starts later. Identical text is always the same.
func sameStart(a, b string) bool {
	if a == b {
		return true
	}
	ta, err1 := time.ParseInLocation(psStartLayout, a, time.Local)
	tb, err2 := time.ParseInLocation(psStartLayout, b, time.Local)
	if err1 != nil || err2 != nil {
		return false
	}
	d := ta.Sub(tb)
	return d >= -startSlack && d <= startSlack
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
