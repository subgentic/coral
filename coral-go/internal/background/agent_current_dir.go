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

// NewCurrentDirFinder is the GitPoller's finder: read is where the transcript says the agent is ("" when it says nothing), and the answer is that place when it passes the checks above, else "".
func NewCurrentDirFinder(read func(sessionID, launchDir, agentType string) string) func(ctx context.Context, a AgentInfo) string {
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
		key := a.WorkingDirectory + "\x00" + cur
		mu.Lock()
		v, ok := seen[key]
		if len(seen) > 1024 {
			seen = map[string]verdict{}
		}
		mu.Unlock()
		if !ok || time.Since(v.at) > currentDirTTL {
			fi, err := os.Stat(cur)
			v = verdict{ok: err == nil && fi.IsDir() && gitutil.SameRepo(ctx, a.WorkingDirectory, cur), at: time.Now()}
			mu.Lock()
			seen[key] = v
			mu.Unlock()
		}
		if !v.ok {
			return ""
		}
		return cur
	}
}
