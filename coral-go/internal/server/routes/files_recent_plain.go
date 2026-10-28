package routes

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/store"
)

// A folder that is not a git repository has no changes to compare, but an agent still writes files there (#10256): the Files list is the folder's recently changed files, newest first.
// The bounds are the file viewer's: inside the folder the session runs in, nothing in a dot folder, no credential file (sensitivePath, for everyone), no symlink, and for a strict
// caller (the Hub, a proxy, curl) a folder the strict rules allow. Beyond those, a week, 100 files, four levels down, 5,000 entries looked at (500 of any one folder, breadth first), and no dependency or build folder (node_modules, vendor, dist, build, .venv as a dot folder, venv, target), so a huge folder costs a bounded walk and does not hide the agent's own files.
const (
	recentPlainMaxFiles   = 100
	recentPlainMaxVisited = 5000
	recentPlainMaxDepth   = 4
	recentPlainWindow     = 7 * 24 * time.Hour
	recentPlainPerDir     = 500 // entries read in any one folder
)

// recentPlainSkipDirs are dependency and build folders: thousands of files a tool wrote, not the agent's. Never walked.
var recentPlainSkipDirs = map[string]bool{"node_modules": true, "vendor": true, "dist": true, "build": true, "venv": true, "__pycache__": true, "target": true}

// recentFilesInPlainFolder lists the files of dir changed in the last week, newest first, as the changed-files list's rows (status "??", no line counts, recorded_at the change time).
func recentFilesInPlainFolder(dir string, strict bool) []store.ChangedFile {
	realRoot, err := safefs.Resolve(dir)
	if err != nil || (strict && !rootAllowed(realRoot)) || sensitivePath(realRoot) {
		return []store.ChangedFile{}
	}
	cutoff := time.Now().Add(-recentPlainWindow)
	type found struct {
		rel string
		at  time.Time
	}
	type pending struct {
		abs, rel string
		depth    int
	}
	var hits []found
	visited := 0
	// Breadth first, so the files near the top of the folder are looked at before anything deep, and at most recentPlainPerDir entries of any one folder: a huge folder (a thousand generated files) cannot
	// spend the whole budget before its siblings are read.
	queue := []pending{{realRoot, "", 1}}
	for len(queue) > 0 && visited < recentPlainMaxVisited {
		cur := queue[0]
		queue = queue[1:]
		entries, err := os.ReadDir(cur.abs)
		if err != nil {
			continue
		}
		if len(entries) > recentPlainPerDir {
			entries = entries[:recentPlainPerDir]
		}
		for _, e := range entries {
			if visited >= recentPlainMaxVisited {
				break
			}
			visited++
			name := e.Name()
			if strings.HasPrefix(name, ".") || e.Type()&fs.ModeSymlink != 0 || sensitivePath(filepath.Join(cur.abs, name)) {
				continue
			}
			childRel := name
			if cur.rel != "" {
				childRel = cur.rel + "/" + name
			}
			if e.IsDir() {
				if cur.depth < recentPlainMaxDepth && !recentPlainSkipDirs[strings.ToLower(name)] {
					queue = append(queue, pending{filepath.Join(cur.abs, name), childRel, cur.depth + 1})
				}
				continue
			}
			if !e.Type().IsRegular() {
				continue
			}
			info, err := e.Info()
			if err != nil || info.ModTime().Before(cutoff) {
				continue
			}
			hits = append(hits, found{childRel, info.ModTime()})
		}
	}
	slices.SortFunc(hits, func(a, b found) int {
		if c := b.at.Compare(a.at); c != 0 {
			return c
		}
		return strings.Compare(a.rel, b.rel)
	})
	if len(hits) > recentPlainMaxFiles {
		hits = hits[:recentPlainMaxFiles]
	}
	out := make([]store.ChangedFile, 0, len(hits))
	for _, h := range hits {
		out = append(out, store.ChangedFile{Filepath: h.rel, Status: "??", RecordedAt: h.at.UTC().Format(time.RFC3339)})
	}
	return out
}
