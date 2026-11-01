package background

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/gitutil"
)

// Where an agent is now (#11704). The agents of a team are launched in one folder and make their own worktrees, so the launch folder says the same branch, commit and changed files for all of them. The place an agent
// has moved to is followed only when it is an existing folder and a git working tree of THE SAME repository as its launch folder (its own worktree): a path an agent writes to its transcript is never a reason for Coral to
// read some other folder. Anything else keeps the launch folder.

const currentDirTTL = 30 * time.Second

// NewCurrentDirFinder is the finder for what the person SEES (a row's current_directory, a text): read is where the transcript says the agent is ("" when it says nothing), and the answer is that place when it
// passes the checks above, else "". A verdict is kept for currentDirTTL, so a list that is asked for every few seconds runs git once in 30.
func NewCurrentDirFinder(read func(sessionID, launchDir, agentType string) string) func(ctx context.Context, a AgentInfo) string {
	return newCurrentDirFinder(read, currentDirTTL, false)
}

// NewCurrentDirReader is the finder for what Coral READS (the git poller's folder, #11739, Security's INFO on #11704): the checks run again at every call, with no kept verdict, and the answer is the folder's REAL path
// (links resolved), so a folder swapped for a link to another repository after it was approved is not read: the next poll finds it is not this repository's and reads the launch folder.
func NewCurrentDirReader(read func(sessionID, launchDir, agentType string) string) func(ctx context.Context, a AgentInfo) string {
	return newCurrentDirFinder(read, 0, true)
}

func newCurrentDirFinder(read func(sessionID, launchDir, agentType string) string, ttl time.Duration, resolve bool) func(ctx context.Context, a AgentInfo) string {
	type verdict struct {
		ok bool
		at time.Time
	}
	var mu sync.Mutex
	seen := map[string]verdict{}
	return func(ctx context.Context, a AgentInfo) string {
		if read == nil || a.WorkingDirectory == "" || a.SessionID == "" {
			return ""
		}
		cur := read(a.SessionID, a.WorkingDirectory, a.AgentType)
		if cur == "" || filepath.Clean(cur) == filepath.Clean(a.WorkingDirectory) {
			return ""
		}
		check := func() bool {
			fi, err := os.Stat(cur)
			return err == nil && fi.IsDir() && gitutil.SameRepo(ctx, a.WorkingDirectory, cur)
		}
		ok := false
		if ttl > 0 {
			key := a.WorkingDirectory + "\x00" + cur
			mu.Lock()
			v, had := seen[key]
			if len(seen) > 1024 {
				seen = map[string]verdict{}
			}
			mu.Unlock()
			if !had || time.Since(v.at) > ttl {
				v = verdict{ok: check(), at: time.Now()}
				mu.Lock()
				seen[key] = v
				mu.Unlock()
			}
			ok = v.ok
		} else {
			ok = check()
		}
		if !ok {
			return ""
		}
		if resolve {
			real, err := filepath.EvalSymlinks(cur)
			if err != nil || !gitutil.SameRepo(ctx, a.WorkingDirectory, real) { // the real folder is the one checked: what is read is what was approved
				return ""
			}
			return real
		}
		return cur
	}
}
