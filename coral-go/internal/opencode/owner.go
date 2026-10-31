package opencode

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Before the real password is sent to a port, the process listening on it must be the server Coral started (#11398). The wrong-password probe needs no secret, so it comes first; then the system is asked who
// listens on 127.0.0.1:<port> and every listener must be the child or one of its descendants (a launcher that starts the real server). A stranger that holds the port and answers a wrong password with 401 is
// then never sent the real one, even if the child stayed alive on another port. Checked on opencode 1.19.5: a build given a held port exits (it does not move), so this is the backstop for a build that does.

var errNoOwnerTool = errors.New("neither lsof nor ss is installed (netstat on Windows), so Coral cannot ask the system who listens on a port: install lsof or ss")

// listenerIsChild reports whether every process listening on TCP port, on any address, is child or a descendant of it, and there is at least one. An error means the system could not be asked (the caller fails
// closed).
func listenerIsChild(ctx context.Context, port, child int) (bool, error) {
	pids, err := listenerPIDs(ctx, port)
	if err != nil {
		return false, err
	}
	if len(pids) == 0 {
		return false, nil
	}
	for _, p := range pids {
		if !isDescendant(ctx, p, child) {
			return false, nil
		}
	}
	return true, nil
}

// listenerPIDs are the pids of the processes listening on TCP port, from the platform's own tool: lsof (macOS, Linux), else ss (Linux), on Windows netstat.
func listenerPIDs(ctx context.Context, port int) ([]int, error) {
	if port < 1 || port > 65535 {
		return nil, fmt.Errorf("not a port: %d", port)
	}
	p := strconv.Itoa(port)
	if runtime.GOOS == "windows" {
		out, err := run(ctx, "netstat", "-ano", "-p", "tcp")
		if err != nil {
			return nil, err
		}
		return parseNetstat(out, port), nil
	}
	if out, err := run(ctx, "lsof", "-nP", "-iTCP:"+p, "-sTCP:LISTEN", "-Fp"); err == nil || (!errors.Is(err, errNoOwnerTool) && lsofSaysNone(err)) {
		return parseLsof(out), nil
	}
	out, err := run(ctx, "ss", "-H", "-ltnp", "sport = :"+p)
	if err != nil {
		return nil, err
	}
	return parseSS(out), nil
}

// lsofSaysNone: lsof exits 1 when nothing matches, which is an answer ("no listener"), not a failure.
func lsofSaysNone(err error) bool {
	var ee *exec.ExitError
	return errors.As(err, &ee) && ee.ExitCode() == 1
}

// run runs a system tool by name (never through a shell, no argument from a request), bounded to 3 s, and returns its output; errNoOwnerTool when it is not there.
func run(ctx context.Context, name string, args ...string) ([]byte, error) {
	path, err := exec.LookPath(name)
	if err != nil {
		return nil, errNoOwnerTool
	}
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, path, args...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "LC_ALL=C"}
	return cmd.Output()
}

// parseLsof reads `lsof -Fp`: one "p<pid>" line for each process.
func parseLsof(out []byte) []int {
	var pids []int
	seen := map[int]bool{}
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "p") {
			if n, err := strconv.Atoi(line[1:]); err == nil && n > 0 && !seen[n] {
				seen[n] = true
				pids = append(pids, n)
			}
		}
	}
	return pids
}

// parseSS reads `ss -H -ltnp`: the users column holds `users:(("name",pid=123,fd=3))`.
func parseSS(out []byte) []int {
	var pids []int
	seen := map[int]bool{}
	for _, f := range strings.Fields(string(out)) {
		for _, part := range strings.Split(f, ",") {
			if strings.HasPrefix(part, "pid=") {
				if n, err := strconv.Atoi(strings.TrimRight(strings.TrimPrefix(part, "pid="), ")")); err == nil && n > 0 && !seen[n] {
					seen[n] = true
					pids = append(pids, n)
				}
			}
		}
	}
	return pids
}

// parseNetstat reads `netstat -ano -p tcp`: "TCP  127.0.0.1:4096  0.0.0.0:0  LISTENING  1234" for the port.
func parseNetstat(out []byte, port int) []int {
	var pids []int
	seen := map[int]bool{}
	suffix := ":" + strconv.Itoa(port)
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) >= 5 && strings.EqualFold(f[0], "TCP") && strings.HasSuffix(f[1], suffix) && strings.EqualFold(f[3], "LISTENING") {
			if n, err := strconv.Atoi(f[4]); err == nil && n > 0 && !seen[n] {
				seen[n] = true
				pids = append(pids, n)
			}
		}
	}
	return pids
}

// isDescendant reports whether pid is child or has it among its ancestors (at most four steps up, by ps; on Windows only child itself counts).
func isDescendant(ctx context.Context, pid, child int) bool {
	if pid == child {
		return true
	}
	if runtime.GOOS == "windows" {
		return false
	}
	for i := 0; i < 4; i++ {
		out, err := run(ctx, "ps", "-o", "ppid=", "-p", strconv.Itoa(pid))
		if err != nil {
			return false
		}
		ppid, err := strconv.Atoi(strings.TrimSpace(string(out)))
		if err != nil || ppid <= 1 {
			return false
		}
		if ppid == child {
			return true
		}
		pid = ppid
	}
	return false
}
