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

// CommonLookup is what a search of the common install places found and why it stopped there: Path is the CLI to use ("" when none), Tried the places that held a file, Refused the reason the first
// file that was found was not used (an agent's working folder, a temp folder, a program the system does not run) and RefusedPath where it was. A launch that finds nothing says all of it.
type CommonLookup struct {
	Path        string
	Tried       []string
	Refused     string
	RefusedPath string
}

// CommonPlaceCLI is the CLI found by CommonPlaceLookup, or "" when none is one to start. screen may be nil; it returns the reason a path is refused, or "".
func CommonPlaceCLI(binary string, screen func(path string) string) string {
	return CommonPlaceLookup(binary, screen).Path
}

// CommonPlaceLookup searches the fixed install places in order (no login shell is asked: that would run the user's startup files inside Coral's server) and takes the first file that is one to start: it must be a program the system runs
// (CheckRunnable), not in a temp folder, and not refused by screen. A file that is found and refused is remembered with its reason and the search goes on.
func CommonPlaceLookup(binary string, screen func(path string) string) CommonLookup {
	var res CommonLookup
	check := func(p string) bool {
		if _, err := os.Stat(p); err != nil { // the link is followed here, at each use: an updater that moves its target is no stale path
			return false
		}
		res.Tried = append(res.Tried, p)
		why := ""
		switch {
		case CheckRunnable(p) != nil:
			why = "not a program the system runs"
		case InTempFolder(p):
			why = "in a temporary folder"
		case screen != nil:
			why = screen(p)
		}
		if why != "" {
			if res.Refused == "" {
				res.Refused, res.RefusedPath = why, p
			}
			return false
		}
		res.Path = p
		return true
	}
	for _, p := range CommonPlaceCandidates(binary) {
		if check(p) {
			return res
		}
	}
	return res
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
