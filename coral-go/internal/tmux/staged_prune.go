package tmux

import (
	"bufio"
	"bytes"
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/logsafe"
)

// Every tmux change leaves one more copy in tmux-bin (#12598), about 2.7 MB each. At start the oldest are removed (#12624): the newest stagedKeep stay, and so does the copy being used now and any copy a live
// process is running from: a tmux server holds every agent's terminal, and the file it runs from is the one thing that must never go.
const stagedKeep = 2

// runningExecutables is the set of executable paths of the processes running now (a variable so a test can fake a running tmux server). Best effort: a failure to ask returns ok false and nothing is removed.
var runningExecutables = func() (map[string]bool, bool) {
	out := map[string]bool{}
	if runtime.GOOS == "linux" {
		ents, err := os.ReadDir("/proc")
		if err != nil {
			return nil, false
		}
		for _, e := range ents {
			if p, err := os.Readlink(filepath.Join("/proc", e.Name(), "exe")); err == nil {
				out[strings.TrimSuffix(p, " (deleted)")] = true
			}
		}
		return out, true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	b, err := exec.CommandContext(ctx, "ps", "-axo", "comm=").Output() // the full path of each process's executable on macOS
	if err != nil {
		return nil, false
	}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" {
			out[l] = true
		}
	}
	return out, true
}

// pruneStaged removes the copies in dir (regular files named tmux-<hex>) older than the newest stagedKeep, except keep and any a running process is using. Nothing is removed when the running processes cannot be listed.
func pruneStaged(dir, keep string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type copyFile struct {
		path string
		mod  time.Time
	}
	var copies []copyFile
	for _, e := range ents {
		if !strings.HasPrefix(e.Name(), "tmux-") {
			continue
		}
		fi, err := os.Lstat(filepath.Join(dir, e.Name()))
		if err != nil || !fi.Mode().IsRegular() { // a link or a folder is not Coral's copy: left alone
			continue
		}
		copies = append(copies, copyFile{filepath.Join(dir, e.Name()), fi.ModTime()})
	}
	if len(copies) <= stagedKeep {
		return
	}
	sort.Slice(copies, func(i, j int) bool { return copies[i].mod.After(copies[j].mod) })
	running, ok := runningExecutables()
	if !ok {
		return
	}
	for _, c := range copies[stagedKeep:] {
		if c.path == keep || running[c.path] {
			continue
		}
		if err := os.Remove(c.path); err == nil {
			log.Printf("[tmux] removed an old staged tmux copy: %s", logsafe.Path(c.path))
		}
	}
}
