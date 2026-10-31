// Package lookpath is exec.LookPath that remembers its answer. On Windows a lookup stats every PATH folder for every PATHEXT extension (a name that is not found: all of them, about 80), and
// Coral looks up git, claude, pwsh, tmux and the agent CLIs at every launch and every git call. Under 'go test' each of those stats is an entry in the test's input log that cmd/go resolves
// again at every cache check, ~0.5 ms each (#413). Standard library only.
//
// The rules (Security on #413):
//   - the answer is kept per name, PATH and PATHEXT: a changed PATH asks again;
//   - a found program is remembered while its file still exists (one stat per call); a file that is gone asks again;
//   - "not found" is remembered for NotFoundFor only, so a program installed a moment later is picked up;
//   - a name that is not a bare program name (a folder, or on Windows a colon, as the standard library tests it) is not a PATH lookup: it goes straight to exec.LookPath;
//   - only an absolute answer is remembered or handed to a caller to start: a relative one (a relative PATH entry under GODEBUG=execerrdot=0) would be read against whatever the working
//     folder is at the next call.
//
// Staleness, stated (Security on #413): a NEW program of the same name that appears EARLIER on PATH is not seen until the remembered file goes or the PATH text changes; the standard library
// would pick it at once. The memo never hands out a program that was not first on PATH when it was found, and a file replaced in place starts as it would at that path anyway.
package lookpath

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// NotFoundFor is how long a "not found" answer is reused.
const NotFoundFor = 10 * time.Second

// Clock is the clock of the memo; a test stores its own (an atomic, since a goroutine an earlier test left running may read it) and stores nil to restore time.Now.
var Clock atomic.Pointer[func() time.Time]

func now() time.Time {
	if f := Clock.Load(); f != nil {
		return (*f)()
	}
	return time.Now()
}

type result struct {
	path string
	err  error
	at   time.Time
}

var memo struct {
	sync.Mutex
	m map[string]result
}

// Path is exec.LookPath(name) remembered as above.
func Path(name string) (string, error) {
	if !IsBare(name) {
		return exec.LookPath(name)
	}
	key := os.Getenv("PATH") + "\x00" + os.Getenv("PATHEXT") + "\x00" + name
	memo.Lock()
	r, ok := memo.m[key]
	memo.Unlock()
	if ok {
		if r.err == nil {
			if _, err := os.Stat(r.path); err == nil {
				return r.path, nil
			}
		} else if now().Sub(r.at) < NotFoundFor {
			return r.path, r.err
		}
	}
	path, err := exec.LookPath(name)
	if err == nil && !filepath.IsAbs(path) {
		return path, err // not remembered, and callers that start programs take only an absolute path
	}
	memo.Lock()
	if memo.m == nil {
		memo.m = map[string]result{}
	}
	memo.m[key] = result{path, err, now()}
	memo.Unlock()
	return path, err
}

// IsBare reports whether name is a bare program name, to be looked up on PATH: the standard library's test (exec.LookPath treats anything else as a path), which on Windows also counts a colon
// (C:git, git.exe:stream) as path-like.
func IsBare(name string) bool {
	if name == "" || filepath.Base(name) != name {
		return false
	}
	return runtime.GOOS != "windows" || !strings.Contains(name, ":")
}
