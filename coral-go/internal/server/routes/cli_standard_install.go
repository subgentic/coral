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
// inside a live agent's working folder is refused), and so do the temp-folder and data-folder refusals and the runnable and owner checks.

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
	// A root the environment names is never as wide as the home folder or wider (npm's documented "prefix=~" would make every folder under home a root): such a value is ignored (Security's SHOULD on #12365).
	// npm's prefix is not a root itself but its bin and lib folders are, where npm puts programs and modules (on Windows npm puts programs in the prefix, so there it is the root).
	if p := narrowEnvRoot(os.Getenv("NPM_CONFIG_PREFIX"), home); p != "" {
		if runtime.GOOS == "windows" {
			add(p)
		} else {
			add(p, "bin")
			add(p, "lib")
		}
	}
	for _, env := range []string{"PNPM_HOME", "VOLTA_HOME", "BUN_INSTALL", "CARGO_HOME"} {
		add(narrowEnvRoot(os.Getenv(env), home))
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

// narrowEnvRoot is an environment-named folder as a root, or "" when it is not absolute or is the home folder, above it, or the filesystem root.
func narrowEnvRoot(v, home string) string {
	if v == "" || !filepath.IsAbs(v) {
		return ""
	}
	v = filepath.Clean(v)
	if v == filepath.Dir(v) {
		return "" // the filesystem root
	}
	if home != "" {
		for _, h := range []string{filepath.Clean(home), filepath.Clean(realOrSelf(home))} {
			for _, e := range []string{v, filepath.Clean(realOrSelf(v))} {
				if e == h || rootOfPath(e, h) { // the home folder, or a folder that holds it
					return ""
				}
			}
		}
	}
	return v
}

// systemRoot says root is one of the three fixed system roots, whose folders are not checked one by one (Homebrew's are group-writable by design): only these; an environment root outside home is checked like any other.
func systemRoot(root string) bool {
	switch filepath.Clean(root) {
	case "/usr/local", "/opt/homebrew", "/home/linuxbrew/.linuxbrew":
		return true
	}
	return false
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
