// Package lookpath is exec.LookPath that remembers its answer. On Windows a lookup stats every PATH folder for every PATHEXT extension (a name that is not found: all of them, about 80), and
// Coral looks up git, claude, pwsh, tmux and the agent CLIs at every launch and every git call. Under 'go test' each of those stats is an entry in the test's input log that cmd/go resolves
// again at every cache check, ~0.5 ms each (#413). Standard library only.
//
// The rules (Security on #413):
//   - the answer is kept per name, PATH and PATHEXT: a changed PATH asks again;
//   - a found program is remembered while its file still exists (one stat per call); a file that is gone asks again;
//   - "not found" is remembered for NotFoundFor only, so a program installed a moment later is picked up;
//   - a name with a folder in it is not a PATH lookup: it goes straight to exec.LookPath.
package lookpath

import (
	"os"
	"os/exec"
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
	if strings.ContainsAny(name, `/\`) || name == "" {
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
	memo.Lock()
	if memo.m == nil {
		memo.m = map[string]result{}
	}
	memo.m[key] = result{path, err, now()}
	memo.Unlock()
	return path, err
}
