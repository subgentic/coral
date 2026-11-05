// Package proctree lists the command lines of the processes below one process (#13645; on Windows, #13659: the image names, from a Toolhelp snapshot): what the resource queue's shell hook asks, after a Bash call returned, to know whether work that call started (an &,
// nohup, a script that forks the suite) still runs. It reads `ps`, once, with a short deadline; where that is not possible (Windows, no ps, a failure) it answers "not known", and the caller then gives the slot
// back when the call ends.
package proctree

import (
	"bufio"
	"strconv"
	"strings"
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

// Image is the process an executable file name stands for on Windows: lower case, without its folder or .exe/.com/.bat/.cmd. A Windows snapshot has no command line (reading one means reading another process's
// memory), so what the hook compares with a resource's patterns there is the program only: "go" for go.exe.
func Image(exeFile string) string {
	n := strings.ToLower(exeFile)
	if i := strings.LastIndexAny(n, `\/`); i >= 0 {
		n = n[i+1:]
	}
	for _, ext := range []string{".exe", ".com", ".bat", ".cmd"} {
		n = strings.TrimSuffix(n, ext)
	}
	return n
}

// FromSnapshot makes Procs from a process snapshot's rows (pid, parent pid, executable file name): the shape CommandsBelow reads on Windows, kept here so it is tested on every system.
func FromSnapshot(rows []SnapshotRow) []Proc {
	procs := make([]Proc, 0, len(rows))
	for _, r := range rows {
		if r.PID == 0 { // the idle process: its "parent" is itself
			continue
		}
		procs = append(procs, Proc{PID: r.PID, PPID: r.PPID, Command: Image(r.ExeFile)})
	}
	return procs
}

// SnapshotRow is one process of a Toolhelp snapshot.
type SnapshotRow struct {
	PID, PPID int
	ExeFile   string
}
