package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/safefs"
	setreg "github.com/subgentic/coral/internal/settings"
)

// worktreeTarget is the folder a new worktree called name is made in, or why it cannot be (#20388, mock #20111). It is the one rule the setup check and the launch share: the name is a branch git accepts and one
// folder name; the folder is the person's own (a full path, no .. in it, a name Coral makes folders with, the parent there) or <repo>-worktrees/name, whose parent Coral makes; never a network path; a caller bounded to
// the projects (a Hub guest) stays inside them. Nothing is created here.
func worktreeTarget(r *http.Request, root, name, custom string) (path, reason, fix string) {
	if len(name) > launchWorktreeNameN || name == "." || name == ".." || strings.ContainsAny(name, `/\: `) || strings.HasPrefix(name, "-") || gitutil.ValidRef(name) != nil || !suggestedDirName.MatchString(name) {
		return "", "that name cannot be a branch and a folder", "use letters, numbers, dots, dashes or underscores"
	}
	def := defaultWorktreeDir(root)
	path = underDefaultWorktreeDir(root, name)
	if path == "" {
		return "", "that name cannot be a branch and a folder", "use letters, numbers, dots, dashes or underscores"
	}
	if custom != "" {
		path = custom
		if !filepath.IsAbs(custom) || filepath.Clean(custom) != strings.TrimRight(custom, `/\`) {
			return "", "the worktree's folder must be a full path with no .. in it", "type a full path, or leave the folder as it was"
		}
		path = filepath.Clean(custom)
		if base := filepath.Base(path); !suggestedDirName.MatchString(base) || strings.HasSuffix(base, ".") || windowsReserved.MatchString(base) {
			return "", "that folder name takes letters, digits, dots, dashes and underscores", "use another folder name"
		}
	}
	if safefs.RefuseRemote(path) != nil {
		return "", "a worktree cannot be made on a network path", "pick a folder on this computer"
	}
	parent := filepath.Dir(path)
	if fi, err := os.Stat(parent); err != nil || !fi.IsDir() {
		if parent != def { // Coral makes <repo>-worktrees; it makes no other folder above a worktree
			return "", "the folder above the worktree does not exist", "pick a folder that exists, or leave the folder as it was"
		}
	} else if strictBounds(r) {
		if _, ok := browsable(r, parent); !ok {
			return "", "that folder is not one Coral may open", "pick a folder inside a project"
		}
	}
	if strictBounds(r) {
		if _, ok := browsable(r, root); !ok {
			return "", "that repository is not one Coral may open", "pick a folder inside a project"
		}
	}
	return path, "", ""
}

// launchNewWorktree asks the launch to make a git worktree first: branch Name from Base (the repository's current branch when empty), in Path (<repo>-worktrees/Name when empty).
type launchNewWorktree struct {
	Name string `json:"name"`
	Base string `json:"base"`
	Path string `json:"path"`
}

// placeLaunchOnBranch makes the new worktree or switches the folder to another branch, before the agent or terminal starts, and returns the folder it starts in. It answers the refusal itself (400 naming the
// field, or 409 with confirm_checkout when the folder has changes the person has not agreed to carry along) and returns ok false. A new worktree needs the "launch into git worktree" setting, as a team's does
// (#12746); git is run only through gitutil.Command (no repository hook or config runs a program of its own).
func (h *SessionsHandler) placeLaunchOnBranch(w http.ResponseWriter, r *http.Request, workingDir string, nw *launchNewWorktree, checkout string, confirm bool) (string, bool) {
	refuse := func(field, msg string) (string, bool) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg, "field": field})
		return "", false
	}
	if nw != nil && checkout != "" {
		return refuse("new_worktree", "ask for a new worktree or another branch, not both")
	}
	ctx := r.Context()
	root := gitutil.TopLevel(ctx, workingDir)
	if root == "" {
		return refuse("working_dir", "this folder is not a git repository, so there is no branch or worktree to use")
	}
	if checkout != "" {
		if gitutil.ValidRef(checkout) != nil || gitutil.Command(ctx, root, "rev-parse", "--verify", "--quiet", "refs/heads/"+checkout).Run() != nil {
			return refuse("checkout_branch", "there is no branch named "+checkout+" in this repository")
		}
		if c := branchFreeCheck(ctx, workingDir, root, checkout); !c.OK {
			return refuse("checkout_branch", c.Reason)
		}
		if !confirm {
			// an agent already running in this folder would find its branch changed under it: say so, and switch only when the person agrees
			if live, err := h.ss.GetAllLiveSessions(ctx); err == nil {
				for _, s := range live {
					if samePath(s.WorkingDir, workingDir) {
						writeJSON(w, http.StatusConflict, map[string]any{"error": s.AgentName + " is running in this folder: switching branch changes the files under it", "field": "checkout_branch", "confirm_checkout": true})
						return "", false
					}
				}
			}
		}
		if out, err := gitutil.Command(ctx, workingDir, "status", "--porcelain=v1", "--untracked-files=normal").Output(); err == nil && strings.TrimSpace(string(out)) != "" && !confirm {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "this folder has uncommitted changes: switching branch may carry them along or stop on a conflict", "field": "checkout_branch", "confirm_checkout": true})
			return "", false
		}
		if out, err := gitutil.Command(ctx, workingDir, "checkout", checkout, "--").CombinedOutput(); err != nil {
			return refuse("checkout_branch", "git could not switch to "+checkout+": "+strings.Join(strings.Fields(string(out)), " "))
		}
		return workingDir, true
	}
	st, err := h.ss.GetSettings(ctx)
	if err != nil {
		errInternalServer(w, err.Error())
		return "", false
	}
	if !setreg.Bool(st, setreg.LaunchInWorktree) {
		return refuse("new_worktree", "Launching in a new git worktree is turned off. Turn on \"Enable launch into git worktree (experimental)\" in Settings to use it.")
	}
	name := strings.TrimSpace(nw.Name)
	path, reason, _ := worktreeTarget(r, root, name, strings.TrimSpace(nw.Path))
	if reason != "" {
		return refuse("new_worktree", reason)
	}
	if _, err := os.Lstat(path); err == nil {
		return refuse("new_worktree", "that folder already exists")
	}
	base, err := gitutil.ResolveBase(ctx, workingDir, nw.Base)
	if err != nil {
		return refuse("new_worktree", err.Error())
	}
	if gitutil.ValidRef(strings.TrimPrefix(base, "origin/")) != nil {
		return refuse("new_worktree", "that base is not a branch name")
	}
	madeParent := false
	if parent := filepath.Dir(path); parent == defaultWorktreeDir(root) {
		if _, err := os.Stat(parent); err != nil {
			madeParent = os.MkdirAll(parent, 0o755) == nil
		}
	}
	if _, err := gitutil.AddTeamWorktree(ctx, root, path, name, base); err != nil {
		if madeParent {
			_ = os.Remove(filepath.Dir(path)) // empty: a refused launch leaves nothing behind
		}
		return refuse("new_worktree", err.Error())
	}
	return path, true
}
