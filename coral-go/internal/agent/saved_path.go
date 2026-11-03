package agent

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
)

// A CLI installer adds its folder to the Path the system keeps for the person (on Windows, the registry's user and system Path), but a Coral that was already running keeps
// the PATH it started with, so the CLI stayed "not found" until Coral restarted. A person's Check again re-reads that saved Path (RefreshSavedPath); the folders it has that
// this process's PATH lacks are then searched after the fixed install places (CommonPlaceCandidates), screened like them. Nothing else reads it, so a launch or an ordinary
// check sees only what the last Check again found, and the process's own PATH is never changed.

// savedPathFolders holds the folders the last RefreshSavedPath found; nil before any.
var savedPathFolders atomic.Pointer[[]string]

// readSavedPath lists the saved Path's folders, system first, as Windows builds a new process's PATH (saved_path_windows.go); nil where there is none. A variable so a test owns it.
var readSavedPath = savedPathDirs

// RefreshSavedPath re-reads the saved Path and keeps its absolute folders that this process's PATH does not hold, without duplicates. It returns how many it kept.
func RefreshSavedPath() int {
	key := func(d string) string {
		c := filepath.Clean(d)
		if filepath.Separator == '\\' {
			c = strings.ToLower(c) // Windows paths compare without case
		}
		return c
	}
	have := map[string]bool{}
	for _, d := range filepath.SplitList(os.Getenv("PATH")) {
		if d = strings.TrimSpace(d); d != "" {
			have[key(d)] = true
		}
	}
	var kept []string
	for _, d := range readSavedPath() {
		d = strings.TrimSpace(d)
		if d == "" || !filepath.IsAbs(d) { // a relative entry would be read against Coral's working folder
			continue
		}
		if onNetworkShare(d) { // a \\server\share folder: never searched from a Check again
			continue
		}
		if vol := filepath.VolumeName(d); len(vol) == 2 && vol[1] == ':' && !localDrive(vol+`\`) { // a drive letter mapped to a share, or one Windows can't tell
			continue
		}
		if k := key(d); !have[k] {
			have[k] = true
			kept = append(kept, filepath.Clean(d))
		}
	}
	savedPathFolders.Store(&kept)
	return len(kept)
}

// onNetworkShare reports whether d is on a network share by its spelling: a UNC path (\\server\share\...) or the long form of one (\\?\UNC\...). Any other \\?\ or \\.\
// device path is treated the same way, as nothing a CLI installer writes to the Path.
func onNetworkShare(d string) bool {
	return strings.HasPrefix(d, `\\`) || strings.HasPrefix(d, `//`)
}

// localDrive reports whether the drive whose root is given (C:\) is one of this computer's own: not a mapped network share, and not a root Windows can't tell
// (fail closed). saved_path_windows.go asks GetDriveType, a local call with no network traffic; a variable so a test owns it.
var localDrive = isLocalDrive

// savedPathDirsFound is what the last RefreshSavedPath kept.
func savedPathDirsFound() []string {
	if p := savedPathFolders.Load(); p != nil {
		return *p
	}
	return nil
}
