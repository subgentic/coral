package branches

import (
	"context"
	"strconv"
	"strings"
	"unicode"
)

// A branch's detail (#17543): what it has over the base, as the Branches tab opens it. Read only when a row is opened (never by the poller), one git process for the commits and one for
// the files, both through readGit (commit ids only, as one range, after --end-of-options), each bounded by gitTimeout.
const (
	MaxCommits    = 50  // commits listed; one more is read to know there are more
	MaxFiles      = 100 // files listed
	maxSubject    = 200 // runes of a commit subject or an author name shown
	maxFilePath   = 200
	rangeOverBase = ".." // the commits the branch has and the base does not
)

// Commit is one commit of a branch over the base. Author is what git records (the machine's git user), not an agent.
type Commit struct {
	ID      string `json:"id"` // the short commit id
	Author  string `json:"author"`
	At      string `json:"at"` // RFC 3339, as git wrote it
	Subject string `json:"subject"`
}

// FileChange is one file the branch changes against the base, with its lines added and removed; Binary: git counts no lines for it.
type FileChange struct {
	Path    string `json:"path"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	Binary  bool   `json:"binary,omitempty"`
}

// Detail is a worktree branch's commits and changed files over the base.
type Detail struct {
	Base        string       `json:"base"`
	Commits     []Commit     `json:"commits"`
	MoreCommits bool         `json:"more_commits,omitempty"`
	Files       []FileChange `json:"files"`
	MoreFiles   bool         `json:"more_files,omitempty"`
}

// Detail reads the commits and files of the worktree of repo whose head is head (a short or full commit id, at least 7 characters). ok is false when no worktree of repo has that head, it is not on a
// local drive, or the repository has no base; err is a git failure (the page says it could not read).
func (c *Collector) Detail(ctx context.Context, repo Repo, head string) (d Detail, ok bool, err error) {
	if len(head) < 7 || repo.baseTip == "" || len(repo.Worktrees) == 0 || repo.Unreadable {
		return d, false, nil
	}
	var w *Worktree
	for i := range repo.Worktrees {
		if h := repo.Worktrees[i].tip; !repo.Worktrees[i].NotLocal && validSHA(h) && strings.HasPrefix(h, strings.ToLower(head)) {
			w = &repo.Worktrees[i]
			break
		}
	}
	root := repo.Worktrees[0].path // the main worktree: a folder git itself listed and Coral resolved
	if w == nil || root == "" || repo.Worktrees[0].NotLocal {
		return d, false, nil
	}
	d = Detail{Base: repo.Base, Commits: []Commit{}, Files: []FileChange{}}
	out, err := c.run(ctx, root, "log", "--max-count=51", "--format=%H%x1f%an%x1f%aI%x1f%s", "--no-color", "--no-show-signature", "--end-of-options", repo.baseTip+rangeOverBase+w.tip)
	if err != nil {
		return d, true, err
	}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Split(line, "\x1f")
		if len(f) != 4 || !validSHA(f[0]) {
			continue
		}
		if len(d.Commits) == MaxCommits {
			d.MoreCommits = true
			break
		}
		d.Commits = append(d.Commits, Commit{ID: f[0][:12], Author: cleanText(f[1], maxSubject), At: strings.TrimSpace(f[2]), Subject: cleanText(f[3], maxSubject)})
	}
	out, err = c.run(ctx, root, "diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-color", "--end-of-options", repo.baseTip+"..."+w.tip)
	if err != nil {
		return d, true, nil // the commits are shown; the files are left out rather than the whole answer
	}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.SplitN(line, "\t", 3)
		if len(f) != 3 {
			continue
		}
		if len(d.Files) == MaxFiles {
			d.MoreFiles = true
			break
		}
		fc := FileChange{Path: cleanText(f[2], maxFilePath)}
		if f[0] == "-" || f[1] == "-" {
			fc.Binary = true
		} else {
			fc.Added, _ = strconv.Atoi(f[0])
			fc.Removed, _ = strconv.Atoi(f[1])
		}
		d.Files = append(d.Files, fc)
	}
	return d, true, nil
}

// cleanText is s as it may be shown: control and format characters and line separators removed, at most n runes (then an ellipsis).
func cleanText(s string, n int) string {
	var b strings.Builder
	k := 0
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) || r == unicode.ReplacementChar {
			continue
		}
		if k == n-1 {
			b.WriteRune('…')
			break
		}
		b.WriteRune(r)
		k++
	}
	return b.String()
}
