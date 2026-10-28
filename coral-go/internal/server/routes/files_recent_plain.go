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
// caller (the Hub, a proxy, curl) a folder the strict rules allow. Beyond those, a week, 100 files, four levels down and 5,000 entries looked at, so a huge folder costs a bounded walk.
const (
	recentPlainMaxFiles   = 100
	recentPlainMaxVisited = 5000
	recentPlainMaxDepth   = 4
	recentPlainWindow     = 7 * 24 * time.Hour
)

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
	var hits []found
	visited := 0
	var walk func(abs, rel string, depth int)
	walk = func(abs, rel string, depth int) {
		entries, err := os.ReadDir(abs)
		if err != nil {
			return
		}
		for _, e := range entries {
			if visited >= recentPlainMaxVisited {
				return
			}
			visited++
			name := e.Name()
			if strings.HasPrefix(name, ".") || e.Type()&fs.ModeSymlink != 0 || sensitivePath(filepath.Join(abs, name)) {
				continue
			}
			childRel := name
			if rel != "" {
				childRel = rel + "/" + name
			}
			if e.IsDir() {
				if depth < recentPlainMaxDepth {
					walk(filepath.Join(abs, name), childRel, depth+1)
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
	walk(realRoot, "", 1)
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
