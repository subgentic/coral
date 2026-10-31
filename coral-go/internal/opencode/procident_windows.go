//go:build windows

package opencode

import (
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// stillActive is the exit code GetExitCodeProcess reports for a process that has not ended.
const stillActive = 259

// maxTreeDepth and maxTreeSize bound how far a server's children are followed when it is ended.
const (
	maxTreeDepth = 8
	maxTreeSize  = 64
)

// openProcess opens pid for what this file does with it: reading its times and image, and ending it. 0 when there is no such process or this user may not touch it.
func openProcess(pid int) windows.Handle {
	if pid <= 4 { // System and Idle are never ours
		return 0
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return 0
	}
	return h
}

// running says the process behind h has not ended (a handle to a process that ended still opens).
func running(h windows.Handle) bool {
	var code uint32
	return windows.GetExitCodeProcess(h, &code) == nil && code == stillActive
}

// creation is when the process began, as the Windows file time in 100 ns steps: it tells a pid's process from the one that has the pid after a restart.
func creation(h windows.Handle) (uint64, bool) {
	var c, e, k, u windows.Filetime
	if err := windows.GetProcessTimes(h, &c, &e, &k, &u); err != nil {
		return 0, false
	}
	return uint64(c.HighDateTime)<<32 | uint64(c.LowDateTime), true
}

// image is the full path of the executable the process runs, "" when it cannot be read.
func image(h windows.Handle) string {
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

// closeHandle closes a handle openProcess returned (0 is nothing).
func closeHandle(h windows.Handle) {
	if h != 0 {
		windows.CloseHandle(h)
	}
}

// processStart is the creation time of pid ("" when it is not running): the same text on every call for the same process.
func processStart(pid int) string {
	h := openProcess(pid)
	if h == 0 {
		return ""
	}
	defer windows.CloseHandle(h)
	if !running(h) {
		return ""
	}
	if t, ok := creation(h); ok {
		return strconv.FormatUint(t, 10)
	}
	return ""
}

// processImage is the executable path of pid ("" when it is not running or cannot be read).
func processImage(pid int) string {
	h := openProcess(pid)
	if h == 0 {
		return ""
	}
	defer windows.CloseHandle(h)
	if !running(h) {
		return ""
	}
	return image(h)
}

// isRecordedServer reports whether rec.PID is still the process that was recorded: running, begun when the record says (to 100 ns) and running the executable the record names. A record without both (one from before
// this was kept) is never trusted: nothing is ended on a guess.
func isRecordedServer(rec pidRecord) bool {
	if rec.Started == "" || rec.Image == "" {
		return false
	}
	h := openProcess(rec.PID)
	if h == 0 {
		return false
	}
	defer windows.CloseHandle(h)
	if !running(h) {
		return false
	}
	t, ok := creation(h)
	if !ok || strconv.FormatUint(t, 10) != rec.Started {
		return false
	}
	return strings.EqualFold(image(h), rec.Image)
}

// endProcess ends the process and the processes it started (a .cmd shim runs cmd.exe, which runs the server): TerminateProcess has no signal to ask with, and ending only the parent would leave its child holding the
// port. It is only called for a pid isRecordedServer vouched for. The children are found by their parent pid, each begun after its parent, and ended before it, within a depth and a count.
func endProcess(pid int) {
	h := openProcess(pid)
	if h == 0 {
		return
	}
	pt, ok := creation(h)
	windows.CloseHandle(h)
	if !ok {
		return
	}
	for _, p := range append(descendants(pid, pt), pidAt{pid, pt}) { // the deepest first, the server last
		if hp := openProcess(p.pid); hp != 0 {
			if t, ok := creation(hp); ok && t == p.created && running(hp) {
				_ = windows.TerminateProcess(hp, 1)
			}
			windows.CloseHandle(hp)
		}
	}
}

type pidAt struct {
	pid     int
	created uint64
}

// descendants are the processes below pid, deepest first: a process counts when its parent pid is one already in the tree and it began after that parent (a reused parent pid does not claim an older process).
func descendants(root int, rootCreated uint64) []pidAt {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	type entry struct{ pid, parent int }
	var all []entry
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err := windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		all = append(all, entry{int(e.ProcessID), int(e.ParentProcessID)})
	}
	var out []pidAt
	level := []pidAt{{root, rootCreated}}
	for depth := 0; depth < maxTreeDepth && len(level) > 0 && len(out) < maxTreeSize; depth++ {
		var next []pidAt
		for _, parent := range level {
			for _, c := range all {
				if c.parent != parent.pid || c.pid == parent.pid {
					continue
				}
				hc := openProcess(c.pid)
				if hc == 0 {
					continue
				}
				t, ok := creation(hc)
				alive := running(hc)
				windows.CloseHandle(hc)
				if ok && alive && t > parent.created && len(out)+len(next) < maxTreeSize {
					next = append(next, pidAt{c.pid, t})
				}
			}
		}
		out = append(next, out...) // deeper levels go before shallower ones
		level = next
	}
	return out
}

// askToEnd ends the server Coral started and the processes it started (a .cmd shim's child holds the port, and Windows has no signal to ask with): there is nothing to wait for. It ends nothing unless the pid is
// still the process that was started: running, begun when it began and running the image it ran (isRecordedServer with the values taken at the start), so a pid another process has by now is never ended. Server.Stop
// still kills the process afterwards if it is somehow there.
func askToEnd(s *Server) {
	pid := s.cmd.Process.Pid
	if isRecordedServer(pidRecord{PID: pid, Started: s.started, Image: s.image}) {
		endProcess(pid)
	}
}

// identityComplete says what was read of a new process is enough to vouch for it later: on Windows its creation time and its image.
func identityComplete(started, image string) bool { return started != "" && image != "" }
