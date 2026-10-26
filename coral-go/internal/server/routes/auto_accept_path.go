package routes

import (
	"errors"
	"io/fs"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/subgentic/coral/internal/safefs"
)

// Devices a shell write may target without risk.
var harmlessDevice = map[string]bool{"/dev/null": true, "/dev/stdout": true, "/dev/stderr": true, "/dev/tty": true}

// notDevices drops the harmless devices from a list of written paths.
func notDevices(paths []string) []string {
	var out []string
	for _, p := range paths {
		if !harmlessDevice[p] && !(runtime.GOOS == "windows" && isDiscard(p)) { // NUL and $null discard output on Windows
			out = append(out, p)
		}
	}
	return out
}

// redirections removes output redirections (>, >>, >|, &>, 2> …) from a
// command segment and returns their targets. Descriptor duplications (2>&1,
// >&2) and process substitutions (>(…)) are not files.
func redirections(seg string) (string, []string) {
	var targets []string
	b := []byte(seg)
	for i := 0; i < len(b); i++ {
		if b[i] == '<' && !(i+1 < len(b) && b[i+1] == '(') {
			// An input redirection (<, <<, <<<) and its operand name no file the command writes: they are not its arguments.
			k := i
			for k < len(b) && b[k] == '<' {
				k++
			}
			for k < len(b) && (b[k] == ' ' || b[k] == '	') {
				k++
			}
			for k < len(b) && !strings.ContainsRune(" 	;&|<>", rune(b[k])) {
				k++
			}
			for x := i; x < k; x++ {
				b[x] = ' '
			}
			i = k - 1
			continue
		}
		if b[i] != '>' {
			continue
		}
		// For ">>", the first ">" has no target and the second is read next.
		// "2>&1" and ">&2" duplicate descriptors: "&" ends the target at once.
		j := i + 1
		for j < len(b) && (b[j] == ' ' || b[j] == '\t') {
			j++
		}
		k := j
		for k < len(b) && !strings.ContainsRune(" \t;&|<>", rune(b[k])) {
			k++
		}
		if t := strings.Trim(string(b[j:k]), `'"`); t != "" {
			targets = append(targets, t)
		}
		for x := i; x < k; x++ {
			b[x] = ' '
		}
		i = k - 1
	}
	return string(b), targets
}

// writeTargets returns the paths a file-writing command writes (or, for mv,
// also removes).
func writeTargets(cmd string, args []string) []string {
	var paths []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case cmd == "dd":
			if strings.HasPrefix(a, "of=") {
				paths = append(paths, strings.TrimPrefix(a, "of="))
			}
		case a == "-t" || a == "--target-directory":
			if i+1 < len(args) {
				return []string{args[i+1]}
			}
		case strings.HasPrefix(a, "--target-directory="):
			return []string{strings.TrimPrefix(a, "--target-directory=")}
		case strings.HasPrefix(a, "-"):
		default:
			paths = append(paths, a)
		}
	}
	switch cmd {
	case "tee", "mv", "dd":
		return paths
	case "install":
		if hasFlag(args, "d", "", "--directory") {
			return paths
		}
	}
	if len(paths) < 2 {
		return nil // ln -s target (a link in the current dir); cp/install need a destination
	}
	return paths[len(paths)-1:]
}

// fromDir makes relative paths absolute from dir (the directory after any cd). From a
// directory that cannot be read literally (dir == ""), a relative path is outside.
func fromDir(args []string, dir string) []string {
	out := make([]string, 0, len(args))
	for _, a := range args {
		if !strings.HasPrefix(a, "-") && !rooted(a) && !unreadablePath(a) {
			if dir == "" {
				a = "$CWD/" + a // unknown directory: never a literal path inside
			} else {
				a = filepath.Join(dir, a)
			}
		}
		out = append(out, a)
	}
	return out
}

// changeDir is the directory after cd/pushd args from dir; "" when it cannot be read
// literally (no argument = home, ~, -, $VAR, $(…)).
func changeDir(dir string, args []string) string {
	var target string
	for _, a := range args {
		if a == "-L" || a == "-P" || a == "-e" || a == "-@" {
			continue
		}
		target = a
		break
	}
	if target == "" || target == "-" || dir == "" || unreadablePath(target) {
		return ""
	}
	if isRooted, abs := rootedPath(runtime.GOOS, target); isRooted {
		if abs == "" {
			return "" // a root with no drive to read (/etc, \Windows, \\server\share, C:foo): not a folder inside this one
		}
		return filepath.Clean(abs)
	}
	return filepath.Join(dir, target)
}

// outsideTarget returns the first non-flag argument that is not a literal
// path inside workDir.
func outsideTarget(args []string, workDir string) string {
	for _, a := range args {
		if strings.HasPrefix(a, "-") {
			continue
		}
		if unreadablePath(a) || !pathInside(a, workDir) {
			return a
		}
	}
	return ""
}

// pathInside reports whether p (absolute, or relative to workDir) is workDir
// or below it. Symlinked prefixes (macOS /tmp -> /private/tmp) are resolved.
func pathInside(p, workDir string) bool {
	if workDir == "" {
		return false
	}
	if wdRooted, wdAbs := rootedPath(runtime.GOOS, workDir); wdRooted && wdAbs == "" {
		// The working folder is itself a path with no drive (an agent in WSL or on another host reports /home/me/proj):
		// nothing here can resolve it, so p is inside only by its text, cleaned, below the folder's text.
		return textInside(p, workDir)
	}
	if isRooted, abs := rootedPath(runtime.GOOS, p); isRooted {
		if abs == "" {
			return false // rooted with no drive to compare (/etc, \Windows, UNC, C:foo): outside, never joined onto workDir
		}
		p = abs
	} else {
		p = filepath.Join(workDir, p)
	}
	wd, target := resolvePath(workDir), resolvePath(p)
	if wd == "" || target == "" {
		return false
	}
	rel, err := filepath.Rel(wd, target)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// textInside is pathInside for a working folder this OS cannot resolve: a relative p is under it, a rooted p only when
// its cleaned text is the folder's or below it. No symlink is followed, so this only ever says "inside" for a path
// written under the folder.
func textInside(p, workDir string) bool {
	wd := path.Clean(strings.ReplaceAll(workDir, `\`, "/"))
	if r, _ := rootedPath("windows", p); r && p[0] != '/' && p[0] != '\\' {
		return false // a path on a drive (C:\x, C:x) is not below a folder that has none
	}
	p = strings.ReplaceAll(p, `\`, "/")
	if r, _ := rootedPath("linux", p); !r {
		p = path.Join(wd, p)
	}
	p = path.Clean(p)
	return p == wd || strings.HasPrefix(p, strings.TrimSuffix(wd, "/")+"/")
}

// resolvePath cleans p and resolves symlinks in its longest existing prefix.
func resolvePath(p string) string {
	p = filepath.Clean(p)
	rest := ""
	for cur := p; ; {
		r, err := safefs.Resolve(cur)
		if err == nil {
			return filepath.Join(r, rest)
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "" // can't be resolved: never taken as inside (#3633)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return p
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
}

// fileRisk returns why a tool's file access is high-risk, or "".
func fileRisk(tool, path, workDir string) string {
	verb, ok := autoAcceptFileTools[tool]
	if !ok || strings.TrimSpace(path) == "" {
		return ""
	}
	if strings.ContainsAny(path, "$`") || strings.HasPrefix(path, "~") || unreadablePath(path) || !pathInside(path, workDir) {
		return "it " + verb + " a file outside the working directory (" + path + ")"
	}
	return ""
}
