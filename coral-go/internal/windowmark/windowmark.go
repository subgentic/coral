// Package windowmark remembers whether Coral's native window was open (#5827): a file in the data folder that exists from when the tray starts coral-app until the person closes
// the window. The tray leaves it when it ends the window itself (an update, Quit), so the update's relaunch can open the window again if the person had it open, and stay in the
// background if they had only the tray.
package windowmark

import (
	"os"
	"path/filepath"
	"time"

	"github.com/subgentic/coral/internal/secfile"
)

// FileName is the marker's name in the data folder.
const FileName = "window_open"

// Set records that the window is open.
func Set(dataDir string) {
	if dataDir == "" {
		return
	}
	// Created without following a link (a symbolic link, a junction or a hard link at that name is refused, and its target is never truncated): the marker is a plain file or nothing (#183).
	f, err := secfile.OpenNoFollow(filepath.Join(dataDir, FileName), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err == nil {
		_ = f.Close()
	}
}

// Clear records that it is not.
func Clear(dataDir string) {
	if dataDir == "" {
		return
	}
	if fi, err := os.Lstat(filepath.Join(dataDir, FileName)); err == nil && fi.Mode().IsRegular() {
		_ = os.Remove(filepath.Join(dataDir, FileName))
	}
}

// ShownFileName is the name of the record that the tray has opened Coral's window (or the dashboard in the browser) at least once for this data folder. The tray writes it itself, so it does
// not depend on analytics, on the tracking milestones or on the server: it is what a start nobody asked for looks at, to open the window once on a fresh install.
const ShownFileName = "window_shown_once"

// AppExitTermsDeclined is the exit code coral-app ends with when the Terms were shown and declined, so the tray, which keeps running, can say so.
const AppExitTermsDeclined = 3

// NoteShown records that the window was shown once. Created without following a link, as Set does.
func NoteShown(dataDir string) {
	if dataDir == "" {
		return
	}
	f, err := secfile.OpenNoFollow(filepath.Join(dataDir, ShownFileName), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err == nil {
		_ = f.Close()
	}
}

// EverShown is whether the window was shown once before: a plain file, never a link or a folder somebody put there.
func EverShown(dataDir string) bool {
	if dataDir == "" {
		return false
	}
	fi, err := os.Lstat(filepath.Join(dataDir, ShownFileName))
	return err == nil && fi.Mode().IsRegular()
}

// Present is whether the window was open when it was last recorded: a plain file, never a link or a folder somebody put there.
func Present(dataDir string) bool {
	if dataDir == "" {
		return false
	}
	fi, err := os.Lstat(filepath.Join(dataDir, FileName))
	return err == nil && fi.Mode().IsRegular()
}

// RaiseFileName is the name of the record that the person's own click started the relaunch after an update (#15772): the new tray brings its window forward once, and only for that. An automatic
// install, or one the Hub's owner asked for, leaves none.
const RaiseFileName = "window_raise"

// NoteRaise records that the person asked for this relaunch. Created without following a link, as Set does.
func NoteRaise(dataDir string) {
	if dataDir == "" {
		return
	}
	f, err := secfile.OpenNoFollow(filepath.Join(dataDir, RaiseFileName), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err == nil {
		_ = f.Close()
	}
}

// ClearRaise takes the record away (a relaunch that did not start).
func ClearRaise(dataDir string) {
	if dataDir == "" {
		return
	}
	if fi, err := os.Lstat(filepath.Join(dataDir, RaiseFileName)); err == nil && fi.Mode().IsRegular() {
		_ = os.Remove(filepath.Join(dataDir, RaiseFileName))
	}
}

// TakeRaise reports whether the person's click started the relaunch that is starting this tray, and removes the record either way: once, never again. A record older than maxAge is a leftover
// of an update that never came up, not of this start, and says no. A link or a folder at that name is not a record.
func TakeRaise(dataDir string, now time.Time, maxAge time.Duration) bool {
	if dataDir == "" {
		return false
	}
	path := filepath.Join(dataDir, RaiseFileName)
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return false
	}
	_ = os.Remove(path)
	return now.Sub(fi.ModTime()) <= maxAge
}
