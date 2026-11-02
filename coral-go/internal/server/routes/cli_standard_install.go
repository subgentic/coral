package routes

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// The standard install roots (#12365, the Operator's decision with Security's answer on #353). A CLI in one of them is never refused because an agent works in a folder that contains it: the rule exists because
// Coral, not the agent, runs the CLI at every launch and wake with the person's authority, so a CLI inside an agent's working folder is a file the agent can replace and Coral will then run; but an agent that works in the
// home folder can already write ~/.zshrc and the CLI's own config, and agents can be started in these folders after the CLI was chosen, so the rule adds nothing there and only confuses. Outside them the rule stays (a CLI
// inside a live agent's working folder, or inside a git working tree, is refused), and so do the temp-folder and data-folder refusals and the runnable and owner checks.

// standardInstallRoots are the folders the common installers put a CLI and what it links to in: ~/.local (bin, share, lib), ~/bin, the npm global folders (~/.npm-global, the prefix NPM_CONFIG_PREFIX names, an nvm
// node's), pnpm's home, Volta, Bun and Cargo, Homebrew and /usr/local; on Windows %LOCALAPPDATA%'s per-CLI folders, Programs and pnpm, %APPDATA%\npm and the same user-level folders under the profile.
func standardInstallRoots() []string {
	var roots []string
	add := func(parts ...string) {
		if len(parts) == 0 || parts[0] == "" {
			return
		}
		roots = append(roots, filepath.Join(parts...))
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		for _, d := range []string{".local", "bin", ".npm-global", ".volta", ".bun", ".cargo", ".nvm"} {
			add(home, d)
		}
		add(home, "Library", "pnpm")
	}
	if p := os.Getenv("NPM_CONFIG_PREFIX"); p != "" {
		add(p)
	}
	for _, env := range []string{"PNPM_HOME", "VOLTA_HOME", "BUN_INSTALL", "CARGO_HOME"} {
		add(os.Getenv(env))
	}
	if runtime.GOOS == "windows" {
		if local := os.Getenv("LOCALAPPDATA"); local != "" { // the per-CLI folders and the usual package managers' folders, not the whole of AppData\Local (which holds the temp folder and every program's data)
			for _, d := range []string{"Programs", "pnpm", "npm", "agy", "claude", "codex", "gemini", "pi", "opencode"} {
				add(local, d)
			}
		}
		add(os.Getenv("APPDATA"), "npm")
	} else {
		add("/usr/local")
		add("/opt/homebrew")
		add("/home/linuxbrew/.linuxbrew")
	}
	return roots
}

// standardInstallPlace says p is a program in a standard install root, on BOTH the path as typed (its folder resolved) and where it resolves to; that the file it leads to is a regular file the current user (or, on
// a system folder, root) owns and group and others cannot write; and, for a root under the home folder, that every folder from the root down to the file is the user's and not writable by group or others (anyone who could
// write ~/.local or ~/.local/share could swap the folder under the file, Security's #11467). A link from a root to somewhere outside every root, a loose file, a folder and a file somebody else owns are not.
func standardInstallPlace(p string) bool {
	p = filepath.Clean(p)
	real := filepath.Clean(realOrSelf(p))
	typed := filepath.Join(realOrSelf(filepath.Dir(p)), filepath.Base(p))
	typedRoot, realRoot := "", ""
	for _, root := range standardInstallRoots() {
		for _, r := range []string{filepath.Clean(root), filepath.Clean(realOrSelf(root))} {
			if typedRoot == "" && (rootOfPath(r, typed) || rootOfPath(r, p)) {
				typedRoot = r
			}
			if realRoot == "" && rootOfPath(r, real) {
				realRoot = r
			}
		}
	}
	if typedRoot == "" || realRoot == "" || !standardFileOK(real) {
		return false
	}
	return standardChainOK(typedRoot, filepath.Dir(typed)) && standardChainOK(realRoot, filepath.Dir(real))
}

// underHome says p is below the home folder (resolved): the roots there are the user's own, and their folders are checked for who can write them.
func underHome(p string) bool {
	home, err := os.UserHomeDir()
	return err == nil && home != "" && (rootOfPath(filepath.Clean(realOrSelf(home)), p) || rootOfPath(filepath.Clean(home), p))
}

// rootOfPath says p is below root (never root itself).
func rootOfPath(root, p string) bool {
	if root == "" || root == "." {
		return false
	}
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// gitTreeOf is the nearest folder above p (not the home folder, and not above it) that has a .git entry, a folder or a worktree's file: the git working tree the CLI sits in, or "". The home folder itself being a git
// tree (a dotfiles repo) is not a project the CLI is in.
func gitTreeOf(p string) string {
	home, _ := os.UserHomeDir()
	rhome := ""
	if home != "" {
		rhome = filepath.Clean(realOrSelf(home))
	}
	for dir := filepath.Dir(filepath.Clean(p)); ; dir = filepath.Dir(dir) {
		if dir == rhome || dir == filepath.Clean(home) || dir == filepath.Dir(dir) {
			return ""
		}
		if _, err := os.Lstat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
	}
}
