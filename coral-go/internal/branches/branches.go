// Package branches keeps, per repository a live agent works in, a read-only picture of its worktrees: each one's branch, how far it is ahead of and behind the repository's base
// branch, whether it has commits left to merge, and how many files are changed in it (goal #11, the Branches tab). The git poller calls Observe once a pass; the route reads Repo for an
// agent's folder and never runs git itself.
//
// Read-only in fact (Security's #6802): every git call is one of the read subcommands in readCommands, through gitutil.Command (no hooks, no fsmonitor, no ext-diff, no filters, no
// submodule recursion, no prompt, no optional locks), with Coral's own GIT_* variables removed from its environment, and never a network subcommand. git is given commit ids only, never a
// branch name: a name is text to show, and one whose cleaned form differs from what git listed is not shown at all.
package branches

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/subgentic/coral/internal/gitutil"
)

// The bounds of one repository and of one pass (Security's SHOULD 6 and 7).
const (
	MaxWorktrees   = 20               // worktrees shown per repository; the rest are counted (More)
	maxUntracked   = 200              // untracked entries counted per worktree; past it, UntrackedMore
	gitTimeout     = 10 * time.Second // one git process
	passBudget     = 20 * time.Second // all repositories of one pass
	refreshEvery   = time.Minute      // a repository is read again at most this often
	askedFor       = 10 * time.Minute // a repository is read only while its tab was read this recently (Security's SHOULD 2 on #272)
	timedOutPause  = 5 * time.Minute  // a repository whose git timed out is left alone this long
	maxBranchRunes = 80
)

// Worktree is one worktree of a repository, as the tab shows it.
type Worktree struct {
	// Branch is the checked-out branch's name, cleaned; "" when detached, or when the name had characters the cleaning would change (NameHidden).
	Branch     string `json:"branch"`
	NameHidden bool   `json:"name_hidden,omitempty"`
	Detached   bool   `json:"detached,omitempty"`
	Head       string `json:"head"` // the short commit id
	Ahead      int    `json:"ahead"`
	Behind     int    `json:"behind"`
	// NothingToMerge: every commit it has over the base is already in the base (merged, rebased or cherry-picked), so it has no commits left to merge. A label, not advice.
	NothingToMerge bool `json:"nothing_to_merge,omitempty"`
	Changed        int  `json:"changed"`   // tracked files with changes
	Untracked      int  `json:"untracked"` // untracked entries, up to maxUntracked
	UntrackedMore  bool `json:"untracked_more,omitempty"`
	// UntrackedUnknown: the untracked scan did not finish (a big tree, or it ran out of time): the count is not known, which is not 0.
	UntrackedUnknown bool `json:"untracked_unknown,omitempty"`
	// NotLocal: git lists this worktree at a path that is not a plain folder on a local fixed drive (a network share, a \\?\ or \\.\ form, a removable drive): it is never opened,
	// read or run in, so a repository's own records cannot make Coral reach out to another host (Security's SHOULD 1 on #272).
	NotLocal   bool `json:"not_local,omitempty"`
	Unreadable bool `json:"unreadable,omitempty"` // its status could not be read
	Main       bool `json:"main,omitempty"`       // the repository's main worktree (the first git lists)

	path string // canonical: what agents' folders are matched against; never served (Security's MUST 5)
	raw  string // the path as git listed it: looked at as text only, before it is known to be local
}

// Repo is one repository's picture.
type Repo struct {
	Base      string     `json:"base"` // the ref the counts are against ("origin/main"), "" when none was found
	Worktrees []Worktree `json:"worktrees"`
	More      int        `json:"more"` // worktrees past MaxWorktrees
	At        time.Time  `json:"at"`
	// Unreadable: git would not read the repository (not a repository any more, or one it calls of dubious ownership, which Coral never overrides).
	Unreadable bool `json:"unreadable,omitempty"`
}

// counts are a branch's numbers against the base, kept while neither tip moves.
type counts struct {
	ahead, behind int
	nothing       bool
}

// Collector holds the pictures. Its zero value is not ready: use New.
type Collector struct {
	mu      sync.Mutex
	repos   map[string]*Repo // by the repository's canonical common git dir
	rootKey map[string]string
	counts  map[string]counts // by base tip + branch tip
	paused  map[string]time.Time
	asked   map[string]time.Time // canonical agent folders whose tab was read, and when
	now     func() time.Time
	run     func(ctx context.Context, dir string, args ...string) ([]byte, error)
}

// New is an empty collector that runs git through gitutil.
func New() *Collector {
	return &Collector{repos: map[string]*Repo{}, rootKey: map[string]string{}, counts: map[string]counts{}, paused: map[string]time.Time{}, asked: map[string]time.Time{}, now: time.Now, run: readGit}
}

// errNotRead is a git call this package does not make.
var errNotRead = errors.New("branches: not a read command")

// readCommands are the only git commands this package runs, with the flags it may give them (Security's MUST 1: the census lists the flags too, readcensus_test.go).
var readCommands = map[string][]string{
	"rev-parse": {"--path-format=absolute", "--git-common-dir", "--show-toplevel", "--verify", "--quiet", "--abbrev-ref", "--end-of-options"},
	"worktree":  {"list", "--porcelain", "-z"},
	"rev-list":  {"--left-right", "--cherry-pick", "--right-only", "--count", "--end-of-options"},
	"status":    {"--porcelain=v1", "-z", "--untracked-files=no", "--untracked-files=normal", "--no-renames", "--ignore-submodules=all"},
}

// readGit runs one read git command in dir and returns its output: through gitutil.Command, with no GIT_* variable of Coral's own in its environment, stdin closed, and gitTimeout.
func readGit(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if !readAllowed(args) {
		return nil, errNotRead
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := gitutil.Command(ctx, dir, args...)
	cmd.Env = scrubGitEnv(cmd.Env)
	cmd.Stdin = nil
	return cmd.Output()
}

// readAllowed says args are a read command and flags of readCommands, the rest being operands (commit ids, refs/... names) that come after --end-of-options where there is one.
func readAllowed(args []string) bool {
	if len(args) == 0 {
		return false
	}
	flags, ok := readCommands[args[0]]
	if !ok {
		return false
	}
	ended := false
	for _, a := range args[1:] {
		if ended || !strings.HasPrefix(a, "-") {
			if args[0] == "worktree" && a != "list" {
				return false
			}
			continue
		}
		known := false
		for _, f := range flags {
			known = known || a == f
		}
		if !known {
			return false
		}
		ended = a == "--end-of-options"
	}
	return true
}

// scrubGitEnv drops GIT_* variables from env, but for the two gitutil sets (GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0): a GIT_DIR or GIT_INDEX_FILE in Coral's own environment would point
// git at another repository or index.
func scrubGitEnv(env []string) []string {
	keep := map[string]bool{}
	for _, kv := range gitutil.Env() {
		keep[kv] = true
	}
	out := env[:0:0]
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "GIT_") && !keep[kv] {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// Observe reads the repositories of roots (the agents' working folders' git roots), each at most every refreshEvery, within passBudget for all of them.
func (c *Collector) Observe(ctx context.Context, roots []string) {
	ctx, cancel := context.WithTimeout(ctx, passBudget)
	defer cancel()
	seen := map[string]bool{}
	sort.Strings(roots)
	for _, root := range roots {
		if ctx.Err() != nil {
			return
		}
		if !c.wanted(root) {
			continue // nobody has the tab open for this repository: no git runs for it
		}
		key := c.repoKey(ctx, root)
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		c.mu.Lock()
		r, until := c.repos[key], c.paused[key]
		c.mu.Unlock()
		now := c.now()
		if now.Before(until) || (r != nil && now.Sub(r.At) < refreshEvery) {
			continue
		}
		start := time.Now()
		repo := c.read(ctx, root)
		c.mu.Lock()
		c.repos[key] = repo
		if time.Since(start) >= gitTimeout || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			c.paused[key] = now.Add(timedOutPause) // one slow repository does not hold every pass
		}
		c.mu.Unlock()
	}
	c.mu.Lock()
	for key := range c.repos { // a repository no agent works in any more is forgotten
		if !seen[key] {
			delete(c.repos, key)
		}
	}
	c.mu.Unlock()
}

// wanted says the tab of an agent working in root was read within askedFor; the ones older are forgotten.
func (c *Collector) wanted(root string) bool {
	r := canonical(root)
	if r == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	want := false
	for dir, at := range c.asked {
		if now.Sub(at) > askedFor {
			delete(c.asked, dir)
			continue
		}
		want = want || within(dir, r)
	}
	return want
}

// repoKey is the canonical common git dir of root's repository (its worktrees share it), "" when it cannot be read.
func (c *Collector) repoKey(ctx context.Context, root string) string {
	c.mu.Lock()
	k, ok := c.rootKey[root]
	c.mu.Unlock()
	if ok {
		return k
	}
	out, err := c.run(ctx, root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "" // asked again next pass
	}
	k = canonical(strings.TrimSpace(string(out)))
	if k != "" {
		c.mu.Lock()
		if len(c.rootKey) > 512 {
			c.rootKey = map[string]string{}
		}
		c.rootKey[root] = k
		c.mu.Unlock()
	}
	return k
}

// read is one repository's picture, read from root.
func (c *Collector) read(ctx context.Context, root string) *Repo {
	repo := &Repo{At: c.now(), Worktrees: []Worktree{}}
	out, err := c.run(ctx, root, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		repo.Unreadable = true
		return repo
	}
	trees := parseWorktrees(out)
	if len(trees) > MaxWorktrees {
		repo.More = len(trees) - MaxWorktrees
		trees = trees[:MaxWorktrees]
	}
	baseName, baseTip := c.base(ctx, root)
	repo.Base = baseName
	for _, w := range trees {
		if localFixedPath(w.raw) {
			w.path = canonical(w.raw)
		} else {
			w.NotLocal = true
		}
		if baseTip != "" && w.Head != "" && validSHA(w.Head) {
			n := c.count(ctx, root, baseTip, w.Head)
			w.Ahead, w.Behind, w.NothingToMerge = n.ahead, n.behind, n.ahead > 0 && n.nothing
		}
		c.status(ctx, &w)
		if len(w.Head) > 12 {
			w.Head = w.Head[:12]
		}
		repo.Worktrees = append(repo.Worktrees, w)
	}
	return repo
}

// baseCandidates are where the base branch is looked for, in order: the remote's default, then origin/main, main, master. Only what is already in the repository: nothing is fetched.
var baseCandidates = []string{"refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/heads/main", "refs/heads/master"}

// base is the repository's base branch, as a short name to show, and its commit id; "" when none exists.
func (c *Collector) base(ctx context.Context, root string) (string, string) {
	for _, ref := range baseCandidates {
		tip, err := c.run(ctx, root, "rev-parse", "--verify", "--quiet", "--end-of-options", ref+"^{commit}")
		if err != nil {
			continue
		}
		sha := strings.TrimSpace(string(tip))
		if !validSHA(sha) {
			continue
		}
		name := strings.TrimPrefix(strings.TrimPrefix(ref, "refs/remotes/"), "refs/heads/")
		if ref == "refs/remotes/origin/HEAD" {
			if short, err := c.run(ctx, root, "rev-parse", "--abbrev-ref", "--end-of-options", ref); err == nil {
				if s := strings.TrimSpace(string(short)); s != "" {
					name = s
				}
			}
		}
		return cleanName(name), sha
	}
	return "", ""
}

// count is tip's numbers against base (both commit ids), kept until either moves.
func (c *Collector) count(ctx context.Context, root, base, tip string) counts {
	key := base + ".." + tip
	c.mu.Lock()
	n, ok := c.counts[key]
	c.mu.Unlock()
	if ok {
		return n
	}
	out, err := c.run(ctx, root, "rev-list", "--left-right", "--count", "--end-of-options", base+"..."+tip)
	if err != nil {
		return counts{}
	}
	f := strings.Fields(string(out))
	if len(f) != 2 {
		return counts{}
	}
	n.behind, _ = strconv.Atoi(f[0])
	n.ahead, _ = strconv.Atoi(f[1])
	if n.ahead > 0 {
		left, err := c.run(ctx, root, "rev-list", "--cherry-pick", "--right-only", "--count", "--end-of-options", base+"..."+tip)
		if err == nil {
			k, _ := strconv.Atoi(strings.TrimSpace(string(left)))
			n.nothing = k == 0
		}
	}
	c.mu.Lock()
	if len(c.counts) > 4096 {
		c.counts = map[string]counts{}
	}
	c.counts[key] = n
	c.mu.Unlock()
	return n
}

// status counts w's changed tracked files, then its untracked entries up to maxUntracked (a big tree's untracked scan is the slow part, so it is separate and capped).
func (c *Collector) status(ctx context.Context, w *Worktree) {
	if w.NotLocal {
		return // never read
	}
	if w.path == "" {
		w.Unreadable = true
		return
	}
	out, err := c.run(ctx, w.path, "status", "--porcelain=v1", "-z", "--untracked-files=no", "--no-renames", "--ignore-submodules=all")
	if err != nil {
		w.Unreadable = true
		return
	}
	w.Changed = len(statusPaths(out))
	out, err = c.run(ctx, w.path, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames", "--ignore-submodules=all")
	if err != nil {
		w.UntrackedUnknown = true // not counted, which is not 0 (Security's INFO a on #272)
		return
	}
	n := 0
	for _, p := range statusPaths(out) {
		if strings.HasPrefix(p, "??") {
			n++
		}
	}
	if n > maxUntracked {
		w.Untracked, w.UntrackedMore = maxUntracked, true
		return
	}
	w.Untracked = n
}

// statusPaths are the entries of `status --porcelain=v1 -z` (with --no-renames, one NUL-ended entry each).
func statusPaths(out []byte) []string {
	var paths []string
	for _, e := range bytes.Split(out, []byte{0}) {
		if len(e) > 3 {
			paths = append(paths, string(e))
		}
	}
	return paths
}

// parseWorktrees reads `worktree list --porcelain -z`: blocks of NUL-ended "key value" lines, a block ended by an empty one. A bare repository's entry is not a worktree.
func parseWorktrees(out []byte) []Worktree {
	var trees []Worktree
	var cur *Worktree
	bare := false
	flush := func() {
		if cur != nil && !bare {
			trees = append(trees, *cur)
		}
		cur, bare = nil, false
	}
	for _, field := range bytes.Split(out, []byte{0}) {
		line := string(field)
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "worktree "):
			flush()
			cur = &Worktree{raw: strings.TrimPrefix(line, "worktree "), Main: len(trees) == 0} // text only: nothing is resolved before the cap and the local-path check (read)
		case cur == nil:
		case strings.HasPrefix(line, "HEAD "):
			cur.Head = strings.TrimPrefix(line, "HEAD ")
		case strings.HasPrefix(line, "branch "):
			raw := strings.TrimPrefix(strings.TrimPrefix(line, "branch "), "refs/heads/")
			if name := cleanName(raw); name == raw {
				cur.Branch = name
			} else {
				cur.NameHidden = true // a name that cleaning would change is never shown as a look-alike (Security's MUST 2)
			}
		case line == "detached":
			cur.Detached = true
		case line == "bare":
			bare = true
		}
	}
	flush()
	return trees
}

var shaRe = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// validSHA says s is a full commit id: the only thing about a branch this package gives git.
func validSHA(s string) bool { return shaRe.MatchString(s) }

// cleanName is a branch or ref name as it may be shown: control and format characters (bidi and zero-width ones are format characters) and line and paragraph separators removed,
// at most maxBranchRunes runes. A name that comes out different from what git listed is not shown at all (parseWorktrees).
func cleanName(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) || r == unicode.ReplacementChar {
			continue
		}
		if n == maxBranchRunes-1 {
			b.WriteRune('…')
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// canonical is p as folders are compared here: absolute, links and junctions resolved, and on Windows its long name in lower case; "" when it cannot be resolved (it then matches nothing).
func canonical(p string) string {
	if p == "" {
		return ""
	}
	abs, err := filepath.Abs(filepath.FromSlash(p))
	if err != nil {
		return ""
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return ""
	}
	return platformCanonical(filepath.Clean(real))
}

// For finds the repository and worktree that dir (an agent's working folder) is in: the worktree whose canonical path is dir or holds it, the deepest one when worktrees nest.
func (c *Collector) For(dir string) (Repo, int, bool) {
	d := canonical(dir)
	if d == "" {
		return Repo{}, -1, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.asked) < 1024 {
		c.asked[d] = c.now() // asking is what makes the next passes read this repository
	}
	best, bestRepo, bestLen := -1, (*Repo)(nil), -1
	for _, r := range c.repos {
		for i, w := range r.Worktrees {
			if w.path != "" && within(d, w.path) && len(w.path) > bestLen {
				best, bestRepo, bestLen = i, r, len(w.path)
			}
		}
	}
	if bestRepo == nil {
		return Repo{}, -1, false
	}
	cp := *bestRepo
	cp.Worktrees = append([]Worktree(nil), bestRepo.Worktrees...)
	return cp, best, true
}

// Holds says worktree i of repo holds dir (another agent's folder), for the tab's agent chips.
func (c *Collector) Holds(r Repo, i int, dir string) bool { return r.Holds(i, dir) }

// Holds says worktree i of r holds dir.
func (r Repo) Holds(i int, dir string) bool {
	if i < 0 || i >= len(r.Worktrees) {
		return false
	}
	d := canonical(dir)
	return d != "" && within(d, r.Worktrees[i].path)
}

// within says dir is root or inside it (both canonical).
func within(dir, root string) bool {
	if dir == root {
		return true
	}
	sep := string(filepath.Separator)
	return strings.HasPrefix(dir, strings.TrimSuffix(root, sep)+sep)
}

// jsonOf is v as JSON text (for the tests' check that no path is served).
func jsonOf(v any) (string, error) {
	b, err := json.Marshal(v)
	return strings.ToLower(string(b)), err
}
