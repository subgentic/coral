// Package protectedpath says which folders a test must never use or make anything in: the person's real ~/.coral and the source tree being tested. It has the standard library only, so
// both testguard (which panics when a test touches them) and testtemp (which refuses a test root there before making it) call the same code (Security, #6675).
package protectedpath

import (
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Dirs is the real ~/.coral of the account (user.Current) and of $HOME, as testguard has always taken them. Worked out once, and only in a test binary's process: user.Current can block
// on directory-service Macs.
var Dirs = sync.OnceValue(func() []string {
	var dirs []string
	add := func(home string) {
		if home == "" {
			return
		}
		d := filepath.Clean(filepath.Join(home, ".coral"))
		for _, existing := range dirs {
			if existing == d {
				return
			}
		}
		dirs = append(dirs, d)
	}
	if u, err := user.Current(); err == nil {
		add(u.HomeDir)
	}
	add(os.Getenv("HOME"))
	return dirs
})

// SourceTree is the nearest folder, from the working directory up, that holds go.mod; found is false when there is none.
var SourceTree = sync.OnceValue(func() (t struct {
	Dir   string
	Found bool
}) {
	wd, err := os.Getwd()
	if err != nil {
		return t
	}
	for dir := wd; ; {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			t.Dir, t.Found = dir, true
			return t
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return t
		}
		dir = parent
	}
})

// RealPath is path made absolute with symlinks resolved. A path that does not exist yet (a socket, a database, a folder about to be made) is resolved through its nearest existing ancestor.
func RealPath(path string) string {
	p := filepath.Clean(path)
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	var rest []string
	for cur := p; ; {
		if resolved, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(append([]string{resolved}, rest...)...)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p
		}
		rest = append([]string{filepath.Base(cur)}, rest...)
		cur = parent
	}
}

// Comparable is RealPath folded the way the file system compares names (macOS and Windows ignore case).
func Comparable(path string) string {
	p := RealPath(path)
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

// Within reports whether path is, or is inside, dir; both are compared as real paths.
func Within(path, dir string) bool {
	p, d := Comparable(path), Comparable(dir)
	return p == d || strings.HasPrefix(p, d+string(filepath.Separator))
}

// Refusal says why a folder that is about to be used as a test root (or made) is not allowed, or "": it is, is inside, or holds the real ~/.coral; it is inside the source tree; or the source
// tree is not known (no go.mod above the working folder), which it says instead of skipping the check. Run it on the path before anything is made, and again on the resolved path.
func Refusal(path string) string { return refusal(path, SourceTree()) }

func refusal(path string, tree struct {
	Dir   string
	Found bool
}) string {
	for _, d := range Dirs() {
		if Within(path, d) || Within(d, path) {
			return "it is, or is inside or around, the real ~/.coral folder"
		}
	}
	if _, err := os.Lstat(filepath.Join(path, ".coral")); err == nil {
		return "it holds a .coral folder"
	}
	if !tree.Found {
		return "no go.mod was found above the working folder, so the source tree is not known"
	}
	if Within(path, tree.Dir) {
		return "it is inside the source tree being tested"
	}
	return ""
}
