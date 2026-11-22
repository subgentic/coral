package routes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/foldertrust"
	"github.com/subgentic/coral/internal/gitutil"
	setreg "github.com/subgentic/coral/internal/settings"
)

// The shared "where" step of a launch (#20388, mock #20111): for a terminal, an agent or a team, what is in the folder the person picked: is it a repository, its current branch and whether it is clean,
// ahead or behind, the other branches, the worktrees it has, and the folders a person has used lately. Both routes are reads (no git command that writes, none that runs a repository's own commands: every
// git call goes through gitutil.Command), served for the folders the folder browser serves (browsable: a bounded caller, a Hub guest, never sees outside the projects), and a remote computer is asked through
// the existing per-computer routes, so its answer is its own. Nothing is created: a new worktree is made by the launch, as before (#12746).

const (
	launchWhereBudget   = 8 * time.Second
	launchMaxBranches   = 200
	launchMaxWorktrees  = 50
	launchMaxRecent     = 8
	launchWorktreeNameN = 64
)

type launchWorktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
	Main   bool   `json:"main,omitempty"`
	Locked bool   `json:"locked,omitempty"`
	Here   bool   `json:"here,omitempty"` // the folder the person picked
}

// LaunchWhere: GET /api/launch/where?path=/some/dir
func (h *SystemHandler) LaunchWhere(w http.ResponseWriter, r *http.Request) {
	dir, ok := browsable(r, r.URL.Query().Get("path"))
	resp := map[string]any{"path": dir, "is_repo": false, "recent": h.recentLaunchFolders(r)}
	if !ok {
		resp["path"] = ""
		resp["reason"] = "that folder is not on this computer, or is not one Coral may open"
		writeJSON(w, http.StatusOK, resp)
		return
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		resp["reason"] = "that folder does not exist on this computer"
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp["exists"] = true
	ctx, cancel := context.WithTimeout(r.Context(), launchWhereBudget)
	defer cancel()
	root := gitutil.TopLevel(ctx, dir)
	if root == "" {
		resp["reason"] = "this folder is not a git repository"
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp["is_repo"], resp["root"] = true, root
	branch := gitutil.CurrentBranch(ctx, dir)
	resp["branch"] = branch
	resp["detached"] = branch == ""
	if out, err := gitutil.Command(ctx, dir, "status", "--porcelain=v1", "--branch", "--untracked-files=normal").Output(); err == nil {
		lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
		changed := 0
		for _, l := range lines {
			if strings.HasPrefix(l, "## ") {
				upstream, ahead, behind := parseStatusBranch(l)
				if upstream != "" {
					resp["upstream"], resp["ahead"], resp["behind"] = upstream, ahead, behind
				}
				continue
			}
			if strings.TrimSpace(l) != "" {
				changed++
			}
		}
		resp["clean"], resp["changed"] = changed == 0, changed
	}
	resp["branches"] = localBranches(ctx, dir)
	resp["worktrees"] = worktreesOf(ctx, dir, root)
	resp["worktree_dir"] = defaultWorktreeDir(root) // where a new worktree goes unless the person edits it: next to the repository, <repo>-worktrees
	resp["worktree_launch"] = h.worktreeLaunchOn(r) // the setting a launch into a worktree needs (#12746): off, the page says so instead of offering it
	writeJSON(w, http.StatusOK, resp)
}

// parseStatusBranch reads `## main...origin/main [ahead 1, behind 2]`.
func parseStatusBranch(line string) (upstream string, ahead, behind int) {
	line = strings.TrimPrefix(line, "## ")
	head, rest, _ := strings.Cut(line, " [")
	if _, up, ok := strings.Cut(head, "..."); ok {
		upstream = strings.TrimSpace(up)
	}
	rest = strings.TrimSuffix(rest, "]")
	for _, part := range strings.Split(rest, ",") {
		part = strings.TrimSpace(part)
		if v, ok := strings.CutPrefix(part, "ahead "); ok {
			ahead, _ = strconv.Atoi(v)
		}
		if v, ok := strings.CutPrefix(part, "behind "); ok {
			behind, _ = strconv.Atoi(v)
		}
	}
	return upstream, ahead, behind
}

func localBranches(ctx context.Context, dir string) []string {
	out, err := gitutil.Command(ctx, dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/").Output()
	if err != nil {
		return []string{}
	}
	names := []string{}
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l = strings.TrimSpace(l); l != "" && gitutil.ValidRef(l) == nil {
			names = append(names, l)
			if len(names) >= launchMaxBranches {
				break
			}
		}
	}
	return names
}

func worktreesOf(ctx context.Context, dir, root string) []launchWorktree {
	out, err := gitutil.Command(ctx, dir, "worktree", "list", "--porcelain").Output()
	if err != nil {
		return []launchWorktree{}
	}
	list := []launchWorktree{}
	var cur *launchWorktree
	flush := func() {
		if cur != nil && len(list) < launchMaxWorktrees {
			list = append(list, *cur)
		}
		cur = nil
	}
	for _, l := range strings.Split(string(out), "\n") {
		switch {
		case strings.HasPrefix(l, "worktree "):
			flush()
			p := filepath.Clean(strings.TrimPrefix(l, "worktree "))
			cur = &launchWorktree{Path: p, Main: len(list) == 0, Here: samePath(p, dir)}
		case cur != nil && strings.HasPrefix(l, "branch refs/heads/"):
			cur.Branch = strings.TrimPrefix(l, "branch refs/heads/")
		case cur != nil && strings.HasPrefix(l, "locked"):
			cur.Locked = true
		}
	}
	flush()
	_ = root
	return list
}

// defaultWorktreeDir is the folder a new worktree is made in unless the person edits it: <repo>-worktrees next to the repository (mock #20111).
func defaultWorktreeDir(root string) string { return filepath.Clean(root) + "-worktrees" }

// underDefaultWorktreeDir is <repo>-worktrees/name, the one place a name is joined to that folder, and "" unless name is one plain folder name (a letter, digit or underscore first, then letters, digits, dots, dashes
// or underscores: no separator, never . or ..) whose folder sits directly in it; callers that get "" refuse the name (#20614, the join census).
func underDefaultWorktreeDir(root, name string) string {
	def := defaultWorktreeDir(root)
	if !suggestedDirName.MatchString(name) {
		return ""
	}
	p := filepath.Join(def, name)
	if filepath.Dir(p) != def || filepath.Base(p) != name {
		return ""
	}
	return p
}

// worktreeLaunchOn reports the "launch into git worktree" setting (off unless turned on, #12746).
func (h *SystemHandler) worktreeLaunchOn(r *http.Request) bool {
	if h.ss == nil {
		return false
	}
	st, err := h.ss.GetSettings(r.Context())
	return err == nil && setreg.Bool(st, setreg.LaunchInWorktree)
}

func samePath(a, b string) bool {
	ra, rb := realPath(a), realPath(b)
	return ra != "" && ra == rb
}

// recentLaunchFolders are the folders a person has used on this computer lately: the pinned ones and the folders of the live sessions, each once, newest first, only the ones still there.
func (h *SystemHandler) recentLaunchFolders(r *http.Request) []string {
	out := []string{}
	if h.ss == nil {
		return out
	}
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" || len(out) >= launchMaxRecent || seen[p] {
			return
		}
		if _, ok := browsable(r, p); !ok { // a bounded caller (the Hub) is shown only the folders it may browse
			return
		}
		if info, err := os.Stat(p); err != nil || !info.IsDir() {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	if pins, err := h.ss.ListPinnedFolders(r.Context()); err == nil {
		for _, p := range pins {
			add(p.Path)
		}
	}
	if live, err := h.ss.GetAllLiveSessions(r.Context()); err == nil {
		sort.SliceStable(live, func(i, j int) bool { return live[i].CreatedAt > live[j].CreatedAt })
		for _, s := range live {
			add(s.WorkingDir)
		}
	}
	return out
}

type launchCheck struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"` // plain words for a failure
	Fix    string `json:"fix,omitempty"`    // what to do about it
	Path   string `json:"path,omitempty"`   // the folder a failure is about, in a path-named field: through the Hub a home path is shown as ~ (HubPaths), never inside a sentence
}

// LaunchCheck: GET /api/launch/check?path=&branch=&new_worktree=&base=&worktree_path=&type=
// The setup check shown before the launch button: repo found, branch exists, worktree free. The CLI's install and sign-in have their own routes (cli-check, cli-signin) and the page asks them for the type
// being launched, so this one runs no program but git. branch names the branch to launch on (empty: the folder as it is); new_worktree is the name of a worktree to make from the branch `base`.
func (h *SystemHandler) LaunchCheck(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dir, ok := browsable(r, q.Get("path"))
	checks := []launchCheck{}
	done := func() {
		all := true
		for _, c := range checks {
			all = all && c.OK
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": all, "checks": checks})
	}
	info, err := os.Stat(dir)
	if !ok || err != nil || !info.IsDir() {
		checks = append(checks, launchCheck{ID: "folder", Reason: "the folder does not exist on this computer", Fix: "pick a folder that exists here"})
		done()
		return
	}
	checks = append(checks, launchCheck{ID: "folder", OK: true})
	ctx, cancel := context.WithTimeout(r.Context(), launchWhereBudget)
	defer cancel()
	branch, from, name := strings.TrimSpace(q.Get("branch")), strings.TrimSpace(q.Get("base")), strings.TrimSpace(q.Get("new_worktree"))
	wtPath := strings.TrimSpace(q.Get("worktree_path"))
	root := gitutil.TopLevel(ctx, dir)
	if root == "" {
		if branch != "" || name != "" {
			checks = append(checks, launchCheck{ID: "repo", Reason: "this folder is not a git repository, so there is no branch or worktree to use", Fix: "pick the repository's folder, or launch in the folder as it is"})
		}
		done()
		return
	}
	checks = append(checks, launchCheck{ID: "repo", OK: true})
	exists := func(b string) bool {
		return gitutil.ValidRef(b) == nil && gitutil.Command(ctx, root, "rev-parse", "--verify", "--quiet", "refs/heads/"+b).Run() == nil
	}
	if branch != "" && name == "" {
		c := launchCheck{ID: "branch", OK: exists(branch)}
		if !c.OK {
			c.Reason, c.Fix = "there is no branch named "+branch+" in this repository", "pick one of its branches, or make a new worktree from one"
		}
		checks = append(checks, c)
		if c.OK {
			checks = append(checks, branchFreeCheck(ctx, dir, root, branch))
		}
	}
	if name != "" {
		if from == "" {
			from = gitutil.CurrentBranch(ctx, dir)
		}
		c := launchCheck{ID: "base", OK: exists(from)}
		if !c.OK {
			c.Reason, c.Fix = "there is no branch named "+from+" to make the worktree from", "pick the branch the worktree starts from"
		}
		checks = append(checks, c)
		checks = append(checks, h.worktreeFreeCheck(ctx, r, root, name, wtPath))
	}
	if t := q.Get("type"); t != "" {
		where := dir
		if name != "" {
			where = worktreePathFor(root, name, wtPath)
		}
		checks = append(checks, folderTrustCheck(t, where))
	}
	done()
}

// branchFreeCheck: a branch checked out in another worktree cannot be launched on there (git allows one checkout of a branch).
func branchFreeCheck(ctx context.Context, dir, root, branch string) launchCheck {
	for _, wt := range worktreesOf(ctx, dir, root) {
		if wt.Branch == branch && !wt.Here {
			return launchCheck{ID: "branch_free", Reason: branch + " is already checked out in another worktree of this repository", Fix: "launch in that worktree, or make a new worktree from " + branch, Path: wt.Path}
		}
	}
	return launchCheck{ID: "branch_free", OK: true}
}

// worktreeFreeCheck: the name is usable as a branch and a folder and nothing is there yet. The folder is the one the person typed, else <repo>-worktrees/name, as the launch makes it.
func (h *SystemHandler) worktreeFreeCheck(ctx context.Context, r *http.Request, root, name, custom string) launchCheck {
	path, reason, fix := worktreeTarget(r, root, name, custom)
	if reason != "" {
		return launchCheck{ID: "worktree_free", Reason: reason, Fix: fix}
	}
	if _, err := os.Lstat(path); err == nil {
		if gitutil.IsRegisteredWorktree(ctx, root, path) {
			return launchCheck{ID: "worktree_free", Reason: "a worktree already exists at that folder", Fix: "pick it from the list, or use another name", Path: path}
		}
		return launchCheck{ID: "worktree_free", Reason: "that folder already exists", Fix: "use another name or folder", Path: path}
	}
	return launchCheck{ID: "worktree_free", OK: true, Path: path}
}

// worktreePathFor is the folder a new worktree called name is made in.
func worktreePathFor(root, name, custom string) string {
	if custom != "" {
		return filepath.Clean(custom)
	}
	return underDefaultWorktreeDir(root, name)
}

// folderTrustCheck says whether the agent's CLI already trusts the folder, so it will not stop to ask. Only Claude's settings are read (a read of one file, never written); any other CLI, or a file that cannot be
// read, is "not checked" and never blocks.
func folderTrustCheck(agentType, folder string) launchCheck {
	c := launchCheck{ID: "trusted"}
	home, err := os.UserHomeDir()
	if agentType != "claude" || err != nil {
		c.OK, c.Reason = true, "not checked: this CLI's trust is not readable"
		return c
	}
	trusted, known := foldertrust.ClaudeTrusted(claudeConfigPath(home), folder)
	if real := realPath(folder); !trusted && real != "" && real != folder { // Claude keys its entries by the folder's real path
		trusted, known = foldertrust.ClaudeTrusted(claudeConfigPath(home), real)
	}
	switch {
	case !known:
		c.OK, c.Reason = true, "not checked: Claude's settings could not be read"
	case trusted:
		c.OK = true
	default:
		c.OK, c.Reason, c.Fix = true, "Claude will ask about this folder when the agent starts", "tick Trust this folder, or answer it in Needs you"
	}
	return c
}
