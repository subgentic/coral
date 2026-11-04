// Package gitguard remembers which folders are too slow for live git updates (#13079). A folder whose git pass takes longer than SlowPass (35,000 changed files took 3 s, back to back, and froze the dashboard) is paused:
// the background poller skips it and the Files panel stops asking, until someone presses Refresh (one pass on demand) or turns live updates back on. A manual pass that comes back fast turns them back on by itself.
// The pauses are kept in a file in the data folder, so a restart does not start the slow polling again.
package gitguard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// SlowPass is how long one pass of git for a folder may take before the folder is paused.
var SlowPass = 2 * time.Second

// StrikesToPause is how many slow passes in a row pause a folder: one slow pass (a build running, a cold disk cache) does not.
const StrikesToPause = 2

// RetryAfter is how long a paused folder waits before the poller tries it again by itself; a pass that comes back fast turns live updates back on.
var RetryAfter = 10 * time.Minute

// Paused is what is known about a paused folder: how many files had changed and how long the pass took.
type Paused struct {
	Changes int       `json:"changes"`
	TookMs  int64     `json:"took_ms"`
	At      time.Time `json:"at"`
}

var (
	mu     sync.Mutex
	paused = map[string]Paused{}
	strike = map[string]int{} // slow passes in a row for a folder that is not paused yet (memory only)
	path   string
)

// Init reads the pauses kept in dir and keeps writing them there. Without Init they live in memory only (tests).
func Init(dir string) {
	mu.Lock()
	defer mu.Unlock()
	path = filepath.Join(dir, "git_paused.json")
	paused = map[string]Paused{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &paused)
		if paused == nil {
			paused = map[string]Paused{}
		}
	}
}

// Reset forgets every pause and the file (tests).
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	paused, strike, path = map[string]Paused{}, map[string]int{}, ""
}

// Get reports whether folder is paused.
func Get(folder string) (Paused, bool) {
	mu.Lock()
	defer mu.Unlock()
	p, ok := paused[folder]
	return p, ok
}

// Pause stops live git updates for folder; changes is how many files had changed (0 when unknown, a pass that timed out).
func Pause(folder string, changes int, took time.Duration) {
	mu.Lock()
	defer mu.Unlock()
	paused[folder] = Paused{Changes: changes, TookMs: took.Milliseconds(), At: time.Now().UTC()}
	save()
}

// Resume turns live git updates back on for folder.
func Resume(folder string) {
	mu.Lock()
	defer mu.Unlock()
	if _, ok := paused[folder]; !ok {
		return
	}
	delete(paused, folder)
	save()
}

func save() {
	if path == "" {
		return
	}
	b, err := json.Marshal(paused)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

// Observe records one pass of git for folder and says whether the folder is paused afterwards. A fast pass clears the folder's slow passes and turns live updates back on if they were paused (a manual Refresh or the
// poller's retry); a slow pass is a strike, and StrikesToPause in a row pause the folder; a slow pass of a paused folder keeps it paused and starts its retry wait again. changes is the Files list's total (0 when unknown).
func Observe(folder string, changes int, took time.Duration) bool {
	mu.Lock()
	defer mu.Unlock()
	if took <= SlowPass {
		delete(strike, folder)
		if _, ok := paused[folder]; ok {
			delete(paused, folder)
			save()
		}
		return false
	}
	if _, ok := paused[folder]; !ok {
		strike[folder]++
		if strike[folder] < StrikesToPause {
			return false
		}
		delete(strike, folder)
	}
	paused[folder] = Paused{Changes: changes, TookMs: took.Milliseconds(), At: time.Now().UTC()}
	save()
	return true
}

// RetryDue reports whether a paused folder has waited RetryAfter since it was paused or last tried, and is due a pass of the poller's own.
func RetryDue(folder string, now time.Time) bool {
	mu.Lock()
	defer mu.Unlock()
	p, ok := paused[folder]
	return ok && now.Sub(p.At) >= RetryAfter
}
