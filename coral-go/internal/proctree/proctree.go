// Package proctree lists the command lines of the processes below one process (#13645): what the resource queue's shell hook asks, after a Bash call returned, to know whether work that call started (an &,
// nohup, a script that forks the suite) still runs. It reads `ps`, once, with a short deadline; where that is not possible (Windows, no ps, a failure) it answers "not known", and the caller then gives the slot
// back when the call ends.
package proctree

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Proc is one process.
type Proc struct {
	PID, PPID int
	Command   string
}

// Parse reads the output of `ps -axo pid=,ppid=,command=`: one process a line, two numbers and the command line.
func Parse(out string) []Proc {
	var procs []Proc
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		ppid, err2 := strconv.Atoi(f[1])
		if err1 != nil || err2 != nil {
			continue
		}
		line := strings.TrimSpace(sc.Text())
		for i := 0; i < 2; i++ { // drop the two numbers, keep the command line as it was
			line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), f[i]))
		}
		procs = append(procs, Proc{PID: pid, PPID: ppid, Command: line})
	}
	return procs
}

// Below is the command line of every process below root (its children, theirs and so on), not root itself.
func Below(procs []Proc, root int) []string {
	kids := map[int][]Proc{}
	for _, p := range procs {
		kids[p.PPID] = append(kids[p.PPID], p)
	}
	var out []string
	seen := map[int]bool{root: true}
	queue := []int{root}
	for len(queue) > 0 {
		at := queue[0]
		queue = queue[1:]
		for _, k := range kids[at] {
			if seen[k.PID] {
				continue
			}
			seen[k.PID] = true
			out = append(out, k.Command)
			queue = append(queue, k.PID)
		}
	}
	return out
}

// CommandsBelow runs ps and answers the command lines below root; ok is false when that cannot be known.
func CommandsBelow(ctx context.Context, root int) (cmds []string, ok bool) {
	if root <= 1 || runtime.GOOS == "windows" {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, psPath(), "-axo", "pid=,ppid=,command=").Output()
	if err != nil {
		return nil, false
	}
	return Below(Parse(string(out)), root), true
}

// psPath is ps by its absolute path, not by the name on the server's PATH (Security's INFO, #13645).
func psPath() string {
	for _, p := range []string{"/bin/ps", "/usr/bin/ps"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "ps"
}
