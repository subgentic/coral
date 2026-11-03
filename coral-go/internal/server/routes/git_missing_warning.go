package routes

import (
	"errors"
	"log/slog"
	"os/exec"
	"sync"
)

// gitMissingOnce makes the "git is not installed" warning appear once per run of the server.
var gitMissingOnce sync.Once

// warnGit logs a failed git command. When git is not on PATH at all, the dashboard's Files and Changes panels ask again every few seconds and each ask used to log one warning per
// command (two or three lines every 4 s for as long as a view was open): the first says plainly that git is missing and what that means, the rest go to debug. Any other failure
// (a repository in a bad state, a timeout) is still one warning each.
func warnGit(msg string, err error, args ...any) {
	if errors.Is(err, exec.ErrNotFound) {
		gitMissingOnce.Do(func() {
			slog.Warn("git is not on PATH: the Files and Changes panels stay empty until it is installed (this is logged once; later git failures of this kind are at debug level)")
		})
		slog.Debug(msg, append(args, "error", err)...)
		return
	}
	slog.Warn(msg, append(args, "error", err)...)
}
