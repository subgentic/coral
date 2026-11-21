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

	"github.com/subgentic/coral/internal/coralnames"
	"github.com/subgentic/coral/internal/gitutil"
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

func samePath(a, b string) bool {
	ra, rb := realPath(a), realPath(b)
	return ra != "" && ra == rb
}

// recentLaunchFolders are the folders a person has used on this computer lately: the pinned ones and the folders of the live sessions, each once, newest first, only the ones still there.
func (h *SystemHandler) recentLaunchFolders(r *http.Request) []string {
	out := []string{}
	if h.ss == nil || !localDashboard(r) && strictBounds(r) {
		return out
	}
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" || len(out) >= launchMaxRecent || seen[p] {
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
}

// LaunchCheck: GET /api/launch/check?path=&branch=&new_worktree=&base=
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
		checks = append(checks, h.worktreeFreeCheck(ctx, root, name))
	}
	done()
}

// branchFreeCheck: a branch checked out in another worktree cannot be launched on there (git allows one checkout of a branch).
func branchFreeCheck(ctx context.Context, dir, root, branch string) launchCheck {
	for _, wt := range worktreesOf(ctx, dir, root) {
		if wt.Branch == branch && !wt.Here {
			return launchCheck{ID: "branch_free", Reason: branch + " is already checked out in " + wt.Path, Fix: "launch in that worktree, or make a new worktree from " + branch}
		}
	}
	return launchCheck{ID: "branch_free", OK: true}
}

// worktreeFreeCheck: the name is usable as a folder and nothing is there yet. The folder is Coral's worktrees folder / name, as the launch makes it.
func (h *SystemHandler) worktreeFreeCheck(ctx context.Context, root, name string) launchCheck {
	bad := func(reason, fix string) launchCheck {
		return launchCheck{ID: "worktree_free", Reason: reason, Fix: fix}
	}
	if len(name) > launchWorktreeNameN || name == "." || name == ".." || strings.ContainsAny(name, `/\: `) || strings.HasPrefix(name, "-") || gitutil.ValidRef(name) != nil {
		return bad("that name cannot be a worktree's folder", "use letters, numbers, dots, dashes or underscores")
	}
	if h.cfg == nil {
		return bad("this computer's worktrees folder is not known", "try again in a moment")
	}
	path := filepath.Join(coralnames.WorktreesRoot(h.cfg.CoralDir()), name)
	if _, err := os.Lstat(path); err == nil {
		if gitutil.IsRegisteredWorktree(ctx, root, path) {
			return bad("a worktree named "+name+" already exists", "pick it from the list, or use another name")
		}
		return bad("a folder named "+name+" is already in the worktrees folder", "use another name")
	}
	return launchCheck{ID: "worktree_free", OK: true}
}
