package background

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/coralnames"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/logsafe"
	"github.com/subgentic/coral/internal/store"
)

// The commits an agent makes in its own worktree (#14095, the Operator: Tokens per commit showed no commits in 24 h while the repository got 455). Agents work in worktrees and run `cd <worktree> && <command>`, so their
// transcripts never name a worktree and the poller saw only the shared checkout. Each pass the poller now also reads the worktrees of a session's repository that are the session's OWN, and records every commit made there
// since the last read (a snapshot of the tip alone misses the commits made between two polls).
//
// A worktree is the session's own when its path has an element that is the session id (the scratchpad folder is named with it), is registered in the session's repository, and, after its links are resolved, is still that
// repository's. No other folder is read. WHICH commits were made in it is read from the worktree's own HEAD reflog (<git dir>/worktrees/<name>/logs/HEAD): git writes a line "commit: <subject>" there for each commit made in that
// worktree and for no other. That needs no guess about where the branch began (a base cut from a newer main, a rebase onto it and a merge of main in all bring other people's commits into the history, and none of them is a
// "commit" line); amends are recorded, merges, pulls, rebases and cherry-picks (replays and landings) are not.

const (
	minSessionIDLen     = 5 // a shorter id could name any folder
	worktreeReadTimeout = 10 * time.Second
	worktreeCommitsMax  = 500 // the most new reflog lines taken in one read
)

// worktreesPerPass is the most worktrees read for new commits in one pass. Timed on this repository (1,081 registered worktrees, 400 of them some session's own) the first read of everything took 12 to 16 s and an idle
// pass about 60 ms; a pass that long would hold up the poller's other work (it warns past 5 s), so the first read is spread: each worktree's progress is its own, and the ones not reached wait for the next pass.
var worktreesPerPass = 25

type registeredWorktree struct {
	path   string // the worktree's folder
	entry  string // its registry folder in the repository (<common dir>/worktrees/<name>)
	reflog string // its HEAD reflog
}

// registeredWorktrees lists the linked worktrees git has registered for the repository at dir, read from the repository's own folder (<common dir>/worktrees/<name>/gitdir names each one's .git file). It reads the files
// rather than running `git worktree list`: git keeps its filter-driver guard (an extra git run) for every worktree subcommand, since `worktree add` checks files out.
func registeredWorktrees(ctx context.Context, dir string) []registeredWorktree {
	ctx, cancel := context.WithTimeout(ctx, worktreeReadTimeout)
	defer cancel()
	out, err := gitutil.Command(ctx, dir, "rev-parse", "--git-common-dir").Output()
	if err != nil {
		return nil
	}
	common := strings.TrimSpace(string(out))
	if common == "" {
		return nil
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	entries, err := os.ReadDir(coralnames.WorktreesRoot(common))
	if err != nil {
		return nil
	}
	var list []registeredWorktree
	for _, e := range entries {
		base := filepath.Join(coralnames.WorktreesRoot(common), e.Name())
		b, err := os.ReadFile(filepath.Join(base, "gitdir"))
		if err != nil {
			continue
		}
		if g := strings.TrimSpace(string(b)); g != "" {
			list = append(list, registeredWorktree{path: filepath.Dir(g), entry: base, reflog: filepath.Join(base, "logs", "HEAD")}) // the worktree's .git file is directly inside it
		}
	}
	return list
}

// pathNamesSession reports whether one element of path is the session id.
func pathNamesSession(path, sessionID string) bool {
	if len(sessionID) < minSessionIDLen {
		return false
	}
	for _, el := range strings.Split(filepath.ToSlash(path), "/") {
		if el == sessionID {
			return true
		}
	}
	return false
}

// objectID is a full commit id: 40 hex digits (SHA-1) or 64 (SHA-256). A reflog is a file a program can write: only an id of this shape is ever handed to git, so nothing in it can be taken for an option.
var objectID = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

// ownedBy reports whether the folder at real is still the worktree the repository registered under entry: its .git file names that very registry folder. Replace the worktree's folder with a link to another
// repository (whose .git is a folder, or a file naming another registry) and this is false. It reads one small file and runs no git.
func ownedBy(real, entry string) bool {
	b, err := os.ReadFile(filepath.Join(real, ".git"))
	if err != nil {
		return false
	}
	g, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir: ")
	if !ok {
		return false
	}
	if !filepath.IsAbs(g) {
		g = filepath.Join(real, g)
	}
	a, errA := filepath.EvalSymlinks(g)
	e, errE := filepath.EvalSymlinks(entry)
	return errA == nil && errE == nil && a == e
}

// madeHere returns the commits a reflog says were made in its worktree, in order: lines "<old> <new> <ident>\tcommit: <subject>" (also "commit (amend):" and "commit (initial):"; not "commit (merge):").
func madeHere(reflog string) []string {
	var shas []string
	for _, line := range strings.Split(reflog, "\n") {
		_, msg, ok := strings.Cut(line, "\t")
		if !ok || !(strings.HasPrefix(msg, "commit:") || strings.HasPrefix(msg, "commit (amend):") || strings.HasPrefix(msg, "commit (initial):")) {
			continue
		}
		f := strings.Fields(line)
		if len(f) >= 2 && objectID.MatchString(f[1]) {
			shas = append(shas, f[1])
		}
	}
	return shas
}

// scanOwnWorktrees reads, for each agent with a session, the new commits of its own worktrees. One listing per launch folder in a pass.
func (p *GitPoller) scanOwnWorktrees(ctx context.Context, agents []AgentInfo) {
	if p.scanned == nil {
		p.scanned = map[string]int{}
	}
	listed := map[string][]registeredWorktree{}
	live := map[string]bool{}
	budget := worktreesPerPass
	for _, a := range agents {
		if a.SessionID == "" || a.WorkingDirectory == "" {
			continue
		}
		list, ok := listed[a.WorkingDirectory]
		if !ok {
			list = registeredWorktrees(ctx, a.WorkingDirectory)
			listed[a.WorkingDirectory] = list
		}
		for _, wt := range list {
			if !pathNamesSession(wt.path, a.SessionID) {
				continue
			}
			real, err := filepath.EvalSymlinks(wt.path)
			if err != nil || !ownedBy(real, wt.entry) { // what is read is what the repository registered: no git run, one small file
				continue
			}
			key := a.SessionID + "\x00" + real
			live[key] = true
			if budget > 0 && p.recordWorktreeCommits(ctx, a, real, key, wt.reflog) { // true: it had new commits to read (git ran)
				budget--
			}
		}
	}
	for k := range p.scanned { // forget the worktrees that are gone, so the map stays bounded
		if !live[k] {
			delete(p.scanned, k)
		}
	}
}

// recordWorktreeCommits records the commits made in one worktree since the last read, oldest first. The lines read are remembered only when every commit was written.
func (p *GitPoller) recordWorktreeCommits(ctx context.Context, a AgentInfo, wt, key, reflogPath string) bool {
	raw, err := os.ReadFile(reflogPath)
	if err != nil {
		return false
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n") // the lines that are there, not the empty piece after the last newline
	done := p.scanned[key]
	if done > len(lines) { // the reflog was expired or rewritten: read it again from its start (a commit already written is ignored)
		done = 0
	}
	if done == len(lines) {
		return false
	}
	shas := madeHere(strings.Join(lines[done:], "\n"))
	if len(shas) > worktreeCommitsMax {
		shas = shas[len(shas)-worktreeCommitsMax:]
	}
	if len(shas) == 0 {
		p.scanned[key] = len(lines)
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, worktreeReadTimeout)
	defer cancel()
	type commit struct{ hash, at, name, email, subject string }
	var commits []commit
	read := func(ids []string) bool {
		args := append([]string{"log", "--no-walk=unsorted", "-z", "--format=%H%x00%aI%x00%an%x00%ae%x00%s", "--end-of-options"}, ids...) // the ids are full hex (objectID); the marker says so to git as well
		out, err := gitutil.Command(ctx, wt, args...).Output()
		if err != nil {
			return false
		}
		f := strings.Split(strings.TrimSuffix(string(out), "\x00"), "\x00")
		for i := 0; i+5 <= len(f); i += 5 {
			commits = append(commits, commit{f[i], f[i+1], f[i+2], f[i+3], f[i+4]})
		}
		return true
	}
	if !read(shas) { // one of them is gone (a prune): take the rest one by one
		commits = nil
		for _, id := range shas {
			read([]string{id})
		}
	}
	branch := ""
	if o, err := gitutil.Command(ctx, wt, "rev-parse", "--abbrev-ref", "HEAD").Output(); err == nil {
		branch = strings.TrimSpace(string(o))
	}
	var identName, identEmail string
	if o, err := gitutil.Command(ctx, wt, "config", "user.name").Output(); err == nil {
		identName = strings.TrimSpace(string(o))
	}
	if o, err := gitutil.Command(ctx, wt, "config", "user.email").Output(); err == nil {
		identEmail = strings.TrimSpace(string(o))
	}
	sid := a.SessionID
	for _, c := range commits { // in the order they were made: the newest is the last row written, as a tip snapshot would be
		at := c.at
		snap := &store.GitSnapshot{AgentName: a.AgentName, AgentType: a.AgentType, WorkingDirectory: wt, Branch: branch, CommitHash: c.hash, CommitSubject: c.subject, CommitTimestamp: &at,
			SessionID: &sid, Worktree: true, AuthorName: c.name, IdentName: identName}
		if p.identityHash != nil {
			snap.AuthorHash, snap.IdentHash = p.identityHash(c.email), p.identityHash(identEmail)
		}
		if err := p.store.UpsertGitSnapshot(ctx, snap); err != nil {
			p.logger.Warn("worktree commit snapshot failed", "agent", a.AgentName, "worktree", logsafe.Dir(wt), "error", err)
			return true // the lines are not marked read: the next pass reads these again
		}
	}
	p.scanned[key] = len(lines)
	return true
}
