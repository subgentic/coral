package main

import (
	"os/exec"

	"github.com/subgentic/coral/internal/windowmark"
)

// What the tray does about the Coral window (#5827): launching Coral.app by hand opens the window, a start that nobody asked for (a login item, the relaunch after an update, a
// restart from Settings) stays in the background, and launching it again while it runs brings the window forward instead of starting a second server.

// opensWindowAtStart is whether a start of the tray opens the Coral window once the server runs. noBrowser is the --no-browser flag (what the updater's relaunch passes, and what a
// person may pass: always quiet); loginItem is that macOS started the app at sign-in, which stays in the background except on a data folder whose window was never shown
// (shownBefore, the tray's own record, windowmark.EverShown: a fresh install's first login-item start opens the window once, so the person is not left with a tray icon and nothing else).
func opensWindowAtStart(noBrowser, loginItem, shownBefore bool) bool {
	switch {
	case noBrowser:
		return false
	case loginItem:
		return !shownBefore
	}
	return true
}

// What the tray says when a start somebody asked for ends with no window (one short sentence each; no link, no token, nothing of the person's).
const (
	noticeWindowNotOpened = "Coral is running. Click the Coral icon in the tray to open it."
	noticeTermsDeclined   = "Coral needs the Terms accepted. Open Coral from the tray to read them."
)

// otherTrayPID is the pid of another running tray of this data folder, or 0: the one a second start of the app hands over to. A start that replaces a tray (a restart from
// Settings waits for it to exit first, restartWaitEnv) is not a second start.
func otherTrayPID(dataDir string, self int, restarting bool, readPID func(string) int) int {
	if restarting {
		return 0
	}
	if pid := readPID(dataDir); pid > 0 && pid != self {
		return pid
	}
	return 0
}

// handOver is what a second start does: ask the running tray to show its window and report whether it did (the caller then exits instead of starting a second server).
func handOver(pid int, ask func(pid int) error) bool {
	return ask(pid) == nil
}

// trackWindow records that the native window process is open (windowmark) and, when it exits, clears the record if it was the person who closed it: isCurrent says the tray has
// not let go of the process itself (killCoralApp does, before it ends the window for an update or Quit, and then the record stays so the relaunch opens the window again).
// It returns when the process has exited, with its exit code (-1 when it did not run to an exit).
func trackWindow(dataDir string, cmd *exec.Cmd, isCurrent func() bool) int {
	windowmark.Set(dataDir)
	_ = cmd.Wait()
	if isCurrent() {
		windowmark.Clear(dataDir)
	}
	if cmd.ProcessState == nil {
		return -1
	}
	return cmd.ProcessState.ExitCode()
}
