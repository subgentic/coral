// Package landedcommits reads which commits reached a team's main branch in a window, from the repository's own history (#7525). The team lands mostly by pushing from a shared checkout, not through the merge
// queue, so the queue's record alone would undercount: the branch's history is the count, the commit's author name is the agent (commits carry role names), and a commit whose author matches no agent is
// "unattributed", never dropped. Git runs only through gitutil.Command (its safe config), the branch is checked as a ref before it is passed, and nothing here writes.
package landedcommits

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/gitutil"
)

// MaxCommits is the most commits one read returns (a window of a very busy repository is cut there and says so).
const MaxCommits = 2000

// readFn is Read; a test replaces it to count the reads a burst makes.
var readFn = Read

var errBadBranch = errors.New("landedcommits: not a branch name")

// readTimeout bounds one git log.
const readTimeout = 20 * time.Second

// logArgs are the arguments of the one git log this package runs: fixed options, the dates formatted here, the ref (always refs/..., never an option) and "--" last.
func logArgs(ref string, since, until time.Time) []string {
	return []string{"log", ref, "--no-merges", "--max-count=" + strconv.Itoa(MaxCommits+1), "--format=%H%x00%an%x00%cI", "--since=" + since.UTC().Format(time.RFC3339), "--until=" + until.UTC().Format(time.RFC3339), "--"}
}

// Commit is one non-merge commit on the branch: its hash, its author's name and when it was committed (RFC 3339, UTC).
type Commit struct {
	Hash   string `json:"hash"`
	Author string `json:"author"`
	At     string `json:"at"`
}

// CommonRoot is the git root most of dirs belong to (a shared checkout gives exactly one; a tie goes to the lexically first), or "" when none of them is in a repository.
func CommonRoot(ctx context.Context, dirs []string) string {
	count := map[string]int{}
	for _, d := range dirs {
		if d == "" {
			continue
		}
		if !gitutil.IsWorkTree(ctx, d) { // ResolveGitRoot answers the folder itself when it is no repository: only a real working tree counts
			continue
		}
		if root := gitutil.ResolveGitRoot(ctx, d); root != "" {
			count[root]++
		}
	}
	best, n := "", 0
	roots := make([]string, 0, len(count))
	for r := range count {
		roots = append(roots, r)
	}
	sort.Strings(roots)
	for _, r := range roots {
		if count[r] > n {
			best, n = r, count[r]
		}
	}
	return best
}

// validBranch is git's own idea of a branch name where it matters here: ValidRef (no option, no whitespace or control) and none of what git forbids in a ref name or reads as a revision expression (.., @{, ^, ~,
// :, ?, *, [, a trailing dot or .lock, a leading or trailing slash, a double slash). A name like main~1 would otherwise name a commit, and shift the counts.
func validBranch(name string) bool {
	if gitutil.ValidRef(name) != nil || strings.ContainsAny(name, "^~:?*[") || strings.Contains(name, "..") || strings.Contains(name, "@{") || strings.Contains(name, "//") ||
		strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") || strings.HasSuffix(name, ".") || strings.HasSuffix(name, ".lock") || strings.HasPrefix(name, ".") || name == "@" {
		return false
	}
	return true
}

func refExists(ctx context.Context, root, ref string) bool {
	return gitutil.Command(ctx, root, "rev-parse", "--verify", "--quiet", ref+"^{commit}").Run() == nil
}

// DefaultBranch is the repository's default branch: what origin/HEAD points at, else main, else master; "" when there is none.
func DefaultBranch(ctx context.Context, root string) string {
	if out, err := gitutil.Command(ctx, root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").Output(); err == nil {
		name := strings.TrimPrefix(strings.TrimSpace(string(out)), "origin/")
		if name != "" && validBranch(name) && (refExists(ctx, root, "refs/heads/"+name) || refExists(ctx, root, "refs/remotes/origin/"+name)) {
			return name
		}
	}
	for _, name := range []string{"main", "master"} {
		if refExists(ctx, root, "refs/heads/"+name) || refExists(ctx, root, "refs/remotes/origin/"+name) {
			return name
		}
	}
	return ""
}

// Read is the non-merge commits of branch committed in [since, until) (git's own --until includes its end, so the end is dropped here), newest first, at most MaxCommits; capped says there were more. The
// local branch is read, else origin's.
func Read(ctx context.Context, root, branch string, since, until time.Time) (commits []Commit, capped bool, err error) {
	if !validBranch(branch) {
		return nil, false, errBadBranch
	}
	ref := "refs/heads/" + branch
	if !refExists(ctx, root, ref) {
		ref = "refs/remotes/origin/" + branch
	}
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()
	out, err := gitutil.Command(ctx, root, logArgs(ref, since, until)...).Output()
	if err != nil {
		return nil, false, err
	}
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		parts := strings.Split(sc.Text(), "\x00")
		if len(parts) != 3 {
			continue
		}
		at := parts[2]
		if t, perr := time.Parse(time.RFC3339, parts[2]); perr == nil {
			at = t.UTC().Format(time.RFC3339)
		}
		if t, perr := time.Parse(time.RFC3339, at); perr == nil && !t.Before(until) {
			continue // --until includes its end; the window does not
		}
		commits = append(commits, Commit{Hash: parts[0], Author: strings.TrimSpace(parts[1]), At: at})
	}
	if len(commits) > MaxCommits {
		commits, capped = commits[:MaxCommits], true
	}
	return commits, capped, sc.Err()
}

// Cache keeps the answers of Read for 60 s, by repository, branch and window, so a page that reloads does not run git each time. The zero value is ready; now is the clock (nil: time.Now).
type Cache struct {
	mu    sync.Mutex
	m     map[string]cached
	now   func() time.Time
	repos map[string]*sync.Mutex // one read at a time per repository: a burst waits for the first and then finds its answer cached
}

type cached struct {
	at      time.Time
	commits []Commit
	capped  bool
	err     error // a failed read, kept for ErrorTTL so a burst against a broken repository does not wait for git once per request
}

// ErrorTTL is how long a failed read is remembered.
const ErrorTTL = 5 * time.Second

// CacheTTL is how long an answer is reused.
const CacheTTL = 60 * time.Second

// Read is the package's Read through the cache. The window is rounded to the minute for the key, so reloads inside it share one answer.
func (c *Cache) Read(ctx context.Context, root, branch string, since, until time.Time) ([]Commit, bool, error) {
	now := time.Now
	if c.now != nil {
		now = c.now
	}
	key := root + "\x00" + branch + "\x00" + since.UTC().Truncate(time.Minute).Format(time.RFC3339) + "\x00" + until.UTC().Truncate(time.Minute).Format(time.RFC3339)
	lookup := func() ([]Commit, bool, error, bool) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if e, ok := c.m[key]; ok {
			if e.err != nil && now().Sub(e.at) < ErrorTTL {
				return nil, false, e.err, true
			}
			if e.err == nil && now().Sub(e.at) < CacheTTL {
				return e.commits, e.capped, nil, true
			}
		}
		return nil, false, nil, false
	}
	if commits, capped, err, ok := lookup(); ok {
		return commits, capped, err
	}
	c.mu.Lock()
	if c.repos == nil {
		c.repos = map[string]*sync.Mutex{}
	}
	rm := c.repos[root]
	if rm == nil {
		rm = &sync.Mutex{}
		c.repos[root] = rm
	}
	c.mu.Unlock()
	rm.Lock()
	defer rm.Unlock()
	if commits, capped, err, ok := lookup(); ok { // an earlier request of the burst has read it (or failed)
		return commits, capped, err
	}
	commits, capped, err := readFn(ctx, root, branch, since, until)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil || len(c.m) > 256 {
		c.m = map[string]cached{}
	}
	c.m[key] = cached{at: now(), commits: commits, capped: capped, err: err}
	return commits, capped, err
}
