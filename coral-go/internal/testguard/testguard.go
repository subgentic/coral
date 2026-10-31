// Package testguard keeps test binaries away from the user's real Coral data
// directory.
//
// The production install lives at ~/.coral: its sessions.db, messageboard.db
// and tmux.sock belong to agents that are running right now. A test that
// resolves a path there (by building a tmux client or config with no data
// dir) can kill live sessions or corrupt their state. CheckDataPath panics
// in that case so the test fails at the call site instead.
package testguard

import (
	"fmt"
	"github.com/subgentic/coral/internal/testguard/protectedpath"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// protectedDirs are the real ~/.coral directories, resolved from the passwd
// entry and from $HOME as it was on the first check. A test that later points
// HOME at a temp dir resolves ~/.coral there, which is allowed. They are
// computed only in test binaries: user.Current can block on directory-service
// Macs, and shipped binaries such as the agent hooks never need it.
var protectedDirs = protectedpath.Dirs

// enabled reports whether the guard applies: only in a running test binary (InTestRun), never on the strength of the program's name or arguments,
// which a launcher of a shipped binary controls (the coral-go-team's Security on #214). It is a variable so the guard's own tests can exercise the
// non-test path.
var enabled = InTestRun

// CheckDataPath panics if this is a test binary and path is, or is inside,
// the user's real ~/.coral directory. Outside tests it does nothing.
func CheckDataPath(path string) {
	if path == "" || !enabled() || inMemoryDB(path) {
		return
	}
	if dir, ok := protected(path); ok {
		panic(fmt.Sprintf("testguard: test resolved %q inside the real Coral data directory %s; "+
			"pass a t.TempDir() (or set CORAL_DATA_DIR / CORAL_TMUX_SOCKET) instead", path, dir))
	}
	if root, ok := inSourceTree(path); ok {
		panic(fmt.Sprintf("testguard: test resolved %q inside the source tree %s; a Config or store with no data folder "+
			"writes into the package folder (api_key, messageboard.db, themes) and every test that scans the tree then sees the files "+
			"(go's test cache re-checks them): pass a t.TempDir() (cfg.UseCoralDir(t.TempDir())) instead", path, root))
	}
}

// inMemoryDB: a SQLite name for a database that has no file: ":memory:", "file::memory:" (alone or followed by "?" and parameters), or a "file:" URI whose query holds the exact
// parameter mode=memory. Nothing is written anywhere, so the path checks do not apply. Narrow on purpose: a file that merely starts or contains such text ("file::memory:evil.db",
// "file:mode=memory.db", "file:x.db#mode=memory") is a real file in the package folder and must reach the source-tree check. SQLite reads mode= only from the query.
func inMemoryDB(name string) bool {
	if name == ":memory:" {
		return true
	}
	rest, ok := strings.CutPrefix(name, "file:")
	if !ok {
		return false
	}
	path, query, hasQuery := strings.Cut(rest, "?")
	if path == ":memory:" {
		return true // "file::memory:" alone or followed by "?"
	}
	if !hasQuery || strings.Contains(query, "%") {
		return false // a percent-escape could spell a second mode= (mod%65=rwc) that SQLite decodes and this check would not see (Security on #214)
	}
	// Exactly one mode= parameter, and it is mode=memory. With two (file:x.db?mode=memory&mode=rwc, or the other order) SQLite's own answer is not
	// worth guessing, so the name is treated as a file (the coral-go-team's Security on #214).
	modes, memory := 0, false
	for _, param := range strings.Split(query, "&") {
		if strings.HasPrefix(param, "mode=") {
			modes++
			memory = param == "mode=memory"
		}
	}
	return modes == 1 && memory
}

// sourceTree is the module's source folder: the nearest parent of the test's working directory (a test runs in its package's folder) that
// holds go.mod, or "" when there is none.
var sourceTree = func() string { return protectedpath.SourceTree().Dir }

// inSourceTree reports whether path is, or is inside, the module's source folder. A relative path counts from the working directory, which is a
// folder of the source tree: the "" data folder a Config falls back to is exactly that.
func inSourceTree(path string) (string, bool) {
	root := sourceTree()
	if root == "" {
		return "", false
	}
	p, cd := comparable(path), sourceTreeResolved()
	if p == cd || strings.HasPrefix(p, cd+string(filepath.Separator)) {
		return root, true
	}
	return "", false
}

// sourceTreeResolved is the source folder's real path, worked out once, as sourceTree itself is: resolving it walks and stats every folder above it, at every CheckDataPath (about 7,500
// calls in routes, four stats each in the test's input log that cmd/go resolves again, #413). The path being checked is still resolved at every call.
var sourceTreeResolved = sync.OnceValue(func() string { return comparable(sourceTree()) })

// protectedResolved is each protected folder with its real path, worked out once: the folders are the person's real ~/.coral, which does not move while a test binary runs, and resolving
// one walks and stats every folder above it. CheckDataPath runs for every store or socket a test opens (about 7,500 times in routes), and under 'go test' each of those stats is an entry
// in the test's input log that cmd/go resolves again, so resolving the live folder per check cost the Go tool minutes per run on a folder no test should touch (#413). The path being
// checked is still resolved at every call, so a symlink that points into the protected folder is still caught. A protected folder that becomes a symlink after the first check is not.
var protectedResolved = sync.OnceValue(func() []protectedDir {
	var out []protectedDir
	for _, d := range protectedDirs() {
		out = append(out, protectedDir{dir: d, real: comparable(d)})
	}
	return out
})

type protectedDir struct{ dir, real string }

func protected(path string) (string, bool) {
	p := comparable(path)
	for _, d := range protectedResolved() {
		if p == d.real || strings.HasPrefix(p, d.real+string(filepath.Separator)) {
			return d.dir, true
		}
	}
	return "", false
}

// protectedIn reports whether path is, or is inside, one of dirs. Both sides
// are compared as real paths (symlinks resolved), and without regard to case
// on macOS, whose default filesystem is case-insensitive, so ~/.Coral or a
// symlink to ~/.coral is caught too.
func protectedIn(path string, dirs []string) (string, bool) {
	p := comparable(path)
	for _, d := range dirs {
		cd := comparable(d)
		if p == cd || strings.HasPrefix(p, cd+string(filepath.Separator)) {
			return d, true
		}
	}
	return "", false
}

func comparable(path string) string {
	p := realPath(path)
	if runtime.GOOS == "darwin" {
		p = strings.ToLower(p)
	}
	return p
}

// realPath is path made absolute with symlinks resolved. A path that does
// not exist yet (a socket or database about to be created) is resolved
// through its nearest existing ancestor.
func realPath(path string) string { return protectedpath.RealPath(path) }
