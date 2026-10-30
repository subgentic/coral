package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/store"
)

// Following an agent into the git worktree it works in (#11351; the operator: "If an agent has switched to a different worktree, it doesn't look like we are following them in the UI"). The Files panel
// used the session's launch folder (the pane's folder, then the live row's working_dir), so an agent launched in a home folder that works in ~/Software/project-wt showed "Not a git folder" and the
// home folder's recent files. The folder it really works in is read from its own events: the files it edited or wrote and the folders its commands cd into or name with git -C.
//
// The choice stays inside what the agent used: each candidate is a folder the agent's own events name, an absolute path, a git work tree (trustedGitRoot), a root the file viewer's bounds allow
// (never the home folder or one that holds it, never a sensitive path); a tool that only looks (Read, Grep, Glob) does not count. The newest qualifying folder decides: when it is the launch folder
// (or inside it) there is nothing to follow. Only a request that asks (worktree=follow) is answered from the followed folder; the rest are as they were.

type followKey struct{}

// followRequested reports whether a request opted into following the agent: the Files panel's own reads send worktree=follow.
func followRequested(r *http.Request) bool { return r.URL.Query().Get("worktree") == "follow" }

func followOn(ctx context.Context) bool { v, _ := ctx.Value(followKey{}).(bool); return v }

// followedWorktree is the worktree an agent works in: its git top level, the folder's own name and its branch.
type followedWorktree struct {
	Dir    string
	Name   string
	Branch string
}

const (
	followEvents     = 200 // how many of the session's newest events are read
	followCandidates = 12  // how many distinct folders are looked at, newest first
	followCacheFor   = 3 * time.Second
)

// the folder a command names first: "cd <dir>" or "git -C <dir>", quoted or not; ~ is the home folder.
var followCmdDir = regexp.MustCompile(`^\s*(?:cd|git\s+-C)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))`)

var editTools = map[string]bool{"Edit": true, "Write": true, "MultiEdit": true, "NotebookEdit": true}

type rootCacheEntry struct {
	at     time.Time
	root   string
	branch string
}

var rootCache sync.Map // folder -> rootCacheEntry: the git work tree of a folder and its branch, kept for a moment so the panel's polls do not run git again and again

// activeWorktree is the worktree the session's agent has most recently worked in, when that is not its launch folder.
func (h *SessionsHandler) activeWorktree(ctx context.Context, name, sessionID, launchDir string) (followedWorktree, bool) {
	if sessionID == "" || h.ts == nil {
		return followedWorktree{}, false
	}
	events, err := h.ts.ListAgentEvents(ctx, "", followEvents, &sessionID) // newest first; by session alone: an event's agent_name is the live row's, which the panel's URL (the tmux session name) is not
	if err != nil {
		return followedWorktree{}, false
	}
	launchRoot := launchDir
	if launchDir != "" {
		if root, _ := cachedRoot(ctx, launchDir); root != "" {
			launchRoot = root
		}
	}
	launchReal := realPath(launchRoot)
	seen := map[string]bool{}
	for _, ev := range events {
		for _, dir := range eventFolders(ev) {
			if seen[dir] {
				continue
			}
			seen[dir] = true
			if len(seen) > followCandidates {
				return followedWorktree{}, false
			}
			root, branch := cachedRoot(ctx, dir)
			if root == "" {
				continue
			}
			if launchReal != "" && within(launchReal, realPath(root)) {
				return followedWorktree{}, false // the newest folder it worked in is its launch folder
			}
			return followedWorktree{Dir: root, Name: filepath.Base(root), Branch: branch}, true
		}
	}
	return followedWorktree{}, false
}

// cachedRoot is the allowed git work tree dir is in, and its branch ("" for a folder that is not one).
func cachedRoot(ctx context.Context, dir string) (string, string) {
	if v, ok := rootCache.Load(dir); ok {
		if e := v.(rootCacheEntry); time.Since(e.at) < followCacheFor {
			return e.root, e.branch
		}
	}
	root := worktreeRoot(ctx, dir)
	branch := ""
	if root != "" {
		branch = branchOf(ctx, root)
	}
	now := time.Now()
	rootCache.Range(func(k, v any) bool { // old entries go as new ones come: the cache holds the folders of the last few seconds, not every folder an agent ever named
		if now.Sub(v.(rootCacheEntry).at) > 2*followCacheFor {
			rootCache.Delete(k)
		}
		return true
	})
	rootCache.Store(dir, rootCacheEntry{at: now, root: root, branch: branch})
	return root, branch
}

// eventFolders are the absolute folders an event says its agent worked in: a file it edited, a folder its command cds into or names with git -C.
func eventFolders(ev store.AgentEvent) []string {
	if ev.ToolName == nil || ev.DetailJSON == nil {
		return nil
	}
	var d map[string]any
	if json.Unmarshal([]byte(*ev.DetailJSON), &d) != nil {
		return nil
	}
	var out []string
	switch tool := *ev.ToolName; {
	case editTools[tool]:
		for _, k := range []string{"file_path", "notebook_path"} {
			if p, _ := d[k].(string); p != "" {
				if abs := absoluteFolder(filepath.Dir(p)); abs != "" {
					out = append(out, abs)
				}
				break
			}
		}
	case tool == "Bash":
		if cmd, _ := d["command"].(string); cmd != "" {
			if m := followCmdDir.FindStringSubmatch(cmd); m != nil {
				for _, g := range m[1:] {
					if g != "" {
						if abs := absoluteFolder(g); abs != "" {
							out = append(out, abs)
						}
						break
					}
				}
			}
		}
	}
	return out
}

// absoluteFolder is p as an absolute clean path (~ expanded), or "" for a relative one: a relative path says nothing about where the agent was.
func absoluteFolder(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	if !filepath.IsAbs(p) {
		return ""
	}
	return filepath.Clean(p)
}

// worktreeRoot is the git work tree dir is in, when the file viewer's bounds allow it as a root: "" otherwise.
func worktreeRoot(ctx context.Context, dir string) string {
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return ""
	}
	root := trustedGitRoot(ctx, dir)
	if root == "" {
		return ""
	}
	real, err := safefs.Resolve(root)
	if err != nil || !rootAllowed(real) || sensitivePath(real) {
		return ""
	}
	return root
}

func branchOf(ctx context.Context, root string) string {
	gctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := gitCmd(gctx, root, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	b := strings.TrimSpace(string(out))
	if b == "HEAD" {
		return "detached"
	}
	return b
}

// withWorktree adds to a files answer the worktree the agent works in, for a request that sent worktree=follow or worktree=launch: where it is, its branch, the folder it was launched in, and whether the
// answer is from it (followed) or from the launch folder with the worktree offered. Nothing when the agent works in its launch folder.
func (h *SessionsHandler) withWorktree(r *http.Request, name, sessionID string, out map[string]any) map[string]any {
	if r.URL.Query().Get("worktree") == "" || strictBounds(r) {
		return out
	}
	launch := h.launchWorkdir(r.Context(), name, "", sessionID)
	if wt, ok := h.activeWorktree(r.Context(), name, sessionID, launch); ok {
		out["worktree"] = map[string]any{"path": wt.Dir, "name": wt.Name, "branch": wt.Branch, "followed": followRequested(r), "launch": launch}
	}
	return out
}
