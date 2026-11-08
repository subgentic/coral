package background

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #14095, the Operator asked how the scan costs on a large repository with many worktrees. This times it on a REAL checkout, read-only: it names the repository in CORAL_SCAN_REPO (skipped when unset), builds one agent
// for each session id that appears in a registered worktree's path, and runs the scan against a throwaway database (never ~/.coral, never the repository). It prints, for a cold pass (every reflog read, every commit
// written) and for an idle pass (nothing new), how many worktrees are registered, how many are some session's own, how many reflog lines were read and how long the pass took.
func TestTimeTheWorktreeScanOnARealRepository(t *testing.T) {
	repo := os.Getenv("CORAL_SCAN_REPO")
	if repo == "" {
		t.Skip("set CORAL_SCAN_REPO to a real checkout to time the scan on it")
	}
	ctx := context.Background()
	list := registeredWorktrees(ctx, repo)
	uuid := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	sessions := map[string]bool{}
	for _, wt := range list {
		for _, el := range strings.Split(filepath.ToSlash(wt.path), "/") {
			if uuid.MatchString(el) {
				sessions[el] = true
			}
		}
	}
	var ids []string
	for s := range sessions {
		ids = append(ids, s)
	}
	sort.Strings(ids)
	var agents []AgentInfo
	for _, s := range ids {
		agents = append(agents, AgentInfo{AgentName: "bench-" + s[:8], AgentType: "claude", SessionID: s, WorkingDirectory: repo})
	}
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	p := NewGitPoller(store.NewGitStore(db), nil, time.Minute)

	lines := func() int {
		n := 0
		for _, wt := range list {
			if b, err := os.ReadFile(wt.reflog); err == nil {
				n += strings.Count(string(b), "\n")
			}
		}
		return n
	}
	own := 0
	for _, a := range agents {
		for _, wt := range list {
			if pathNamesSession(wt.path, a.SessionID) {
				own++
			}
		}
	}
	// passes until nothing new is read (the first read is spread over passes, worktreesPerPass at a time)
	var durations []time.Duration
	var total, longest time.Duration
	for pass := 0; pass < 200; pass++ {
		before := p.scannedLines()
		t0 := time.Now()
		p.scanOwnWorktrees(ctx, agents)
		d := time.Since(t0)
		durations = append(durations, d)
		total += d
		if d > longest {
			longest = d
		}
		if p.scannedLines() == before && pass > 0 {
			break
		}
	}
	idle := durations[len(durations)-1]
	var rows int
	require.NoError(t, db.Get(&rows, `SELECT COUNT(*) FROM git_snapshots`))
	t2 := time.Now()
	_ = registeredWorktrees(ctx, repo)
	registry := time.Since(t2)
	t.Logf("repo %s: %d registered worktrees, %d sessions named in their paths, %d worktrees that are some session's own, %d reflog lines in all registered worktrees (%d read by the scan's own worktrees)", repo, len(list), len(agents), own, lines(), p.scannedLines())
	t.Logf("first read spread over %d passes (%d worktrees at a time), %d commit rows written to a throwaway database: longest pass %v, all passes together %v; the idle pass after it (nothing new): %v; the registry read alone (one rev-parse and %d small files): %v", len(durations), worktreesPerPass, rows, longest, total, idle, len(list), registry)
}

// scannedLines is the number of reflog lines the scan has read so far, over every worktree it follows.
func (p *GitPoller) scannedLines() int {
	n := 0
	for _, v := range p.scanned {
		n += v
	}
	return n
}
