package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// A CLI found in a common install place (npm's global folders, %LOCALAPPDATA%\agy\bin, ~/.local/bin, ...) is started by the agent's launch line, so the place is screened
// like a configured path (#353, Security's #3019): the file must be a program the system runs (CheckRunnable), must not sit in a temp folder, and must not be in a folder
// the caller's screen refuses (the routes pass untrustedLocation: an agent's working folder, Coral's data folder). A CLI that fails is not picked up, as if the place were empty.
// Coral never opens a place by walking a junction Windows refuses and never resolves a junction chain itself: FindCLIInCommonPaths only stats the fixed candidates.

// CommonPlaceCLI is FindCLIInCommonPaths for binary, or "" when the file found there is not one to start. screen may be nil; it returns the reason a path is refused, or "".
func CommonPlaceCLI(binary string, screen func(path string) string) string {
	p := FindCLIInCommonPaths(binary)
	if p == "" {
		return ""
	}
	if CheckRunnable(p) != nil || InTempFolder(p) {
		return ""
	}
	if screen != nil && screen(p) != "" {
		return ""
	}
	return p
}

// InTempFolder reports whether p is inside the system temp folder (os.TempDir), by the folder's name and by where it leads.
func InTempFolder(p string) bool {
	tmp := os.TempDir()
	if tmp == "" || p == "" {
		return false
	}
	for _, a := range spellings(tmp) {
		for _, b := range spellings(p) {
			if within(a, b) {
				return true
			}
		}
	}
	return false
}

func spellings(p string) []string {
	out := []string{filepath.Clean(p)}
	if r, err := filepath.EvalSymlinks(p); err == nil && filepath.Clean(r) != out[0] {
		out = append(out, filepath.Clean(r))
	} else if r, err := filepath.EvalSymlinks(filepath.Dir(p)); err == nil {
		out = append(out, filepath.Join(filepath.Clean(r), filepath.Base(p)))
	}
	return out
}

func within(dir, p string) bool {
	if runtime.GOOS == "windows" {
		dir, p = strings.ToLower(dir), strings.ToLower(p)
	}
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
