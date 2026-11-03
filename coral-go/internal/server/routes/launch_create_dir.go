package routes

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/cloud"
)

// suggestedDirName is the one folder name a launch may ask Coral to create: letters, digits, dot, dash and underscore, no leading dot (#11258 item 3).
var suggestedDirName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$`)

// windowsReserved are the device names Windows refuses as a file or folder name, with or without an extension; they are refused on every platform so a folder made
// here can be opened anywhere.
var windowsReserved = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)`)

// createSuggestedDir makes the folder the dialog suggested for a first agent or team, <home>/Coral/<name>, when the request says create_dir. It makes only that
// exact shape: one plain name directly under a Coral folder in the home folder (or in CORAL_ROOT), and never through a link. Any other path is left to
// launchDirError, so create_dir cannot make a folder anywhere else. It returns "" when nothing is wrong, including when the folder was not asked for.
func createSuggestedDirReport(dir string, create bool, roots ...string) (msg string, made bool) {
	if !create || dir == "" {
		return "", false
	}
	clean := filepath.Clean(dir)
	name := filepath.Base(clean)
	parent := filepath.Dir(clean)
	if !suggestedDirName.MatchString(name) || strings.HasSuffix(name, ".") || windowsReserved.MatchString(name) {
		return fmt.Sprintf("can't create %s: a folder name takes letters, digits, dots, dashes and underscores, and is not a reserved or dot-ending name", dir), false
	}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, home)
	}
	for _, root := range roots {
		if root == "" || !filepath.IsAbs(root) {
			continue
		}
		coral := filepath.Join(filepath.Clean(root), "Coral")
		if parent != coral {
			continue
		}
		// One level at a time, each Mkdir then an Lstat: a link put in place between the check and the make is seen, not followed.
		if err := os.Mkdir(coral, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return fmt.Sprintf("can't create %s: %v", dir, err), false
		}
		if fi, err := os.Lstat(coral); err != nil || fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
			return fmt.Sprintf("can't create %s: %s is not a plain folder", dir, coral), false
		}
		made = true
		if err := os.Mkdir(clean, 0o700); errors.Is(err, fs.ErrExist) {
			made = false // it was there: not a folder this launch made
		} else if err != nil {
			return fmt.Sprintf("can't create %s: %v", dir, err), false
		}
		if fi, err := os.Lstat(clean); err != nil || fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
			return fmt.Sprintf("can't create %s: it is not a plain folder", dir), false
		}
		return "", made
	}
	return fmt.Sprintf("can't create %s: Coral makes only a folder directly under Coral in your home folder", dir), false
}

// createSuggestedDir is createSuggestedDirReport without the report of whether this call made the folder.
func createSuggestedDir(dir string, create bool, roots ...string) string {
	msg, _ := createSuggestedDirReport(dir, create, roots...)
	return msg
}

// createChosenFolder makes the ONE new folder a person chose at step 1 of a launch (#12833): step 1 said "Coral creates this folder when you launch", for a folder that does not exist yet inside a folder that does.
// Only that: an absolute path already in its cleaned form (no .. and no doubled separators), whose last element is one plain name (the same rule as the suggested folder), directly inside a parent that exists and is a
// folder. One os.Mkdir (never MkdirAll: no parent is made, and a name that is already there, a link included, is not followed or replaced), then an Lstat that the result is a plain folder. It returns made false, with no
// message, when the folder was already there: it is then an ordinary folder and the launch checks it as before.
func createChosenFolder(dir string) (msg string, made bool) {
	if dir == "" {
		return "", false
	}
	if !filepath.IsAbs(dir) || filepath.Clean(dir) != strings.TrimRight(dir, `/\`) {
		return fmt.Sprintf("can't create %s: Coral makes a new folder only at a full path with no .. in it", dir), false
	}
	clean := filepath.Clean(dir)
	name, parent := filepath.Base(clean), filepath.Dir(clean)
	if !suggestedDirName.MatchString(name) || strings.HasSuffix(name, ".") || windowsReserved.MatchString(name) {
		return fmt.Sprintf("can't create %s: a folder name takes letters, digits, dots, dashes and underscores, and is not a reserved or dot-ending name", dir), false
	}
	if fi, err := os.Stat(parent); err != nil || !fi.IsDir() {
		return fmt.Sprintf("can't create %s: %s is not a folder that exists", dir, parent), false
	}
	if err := os.Mkdir(clean, 0o700); errors.Is(err, fs.ErrExist) {
		return "", false
	} else if err != nil {
		return fmt.Sprintf("can't create %s: %v", dir, err), false
	}
	if fi, err := os.Lstat(clean); err != nil || fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return fmt.Sprintf("can't create %s: it is not a plain folder", dir), false
	}
	return "", true
}

// newFolderCallerRefusal is why this request may not ask Coral to make a new folder, "" when it may (#12833): only a person at this computer's own dashboard or command line. An agent's token is refused (an agent
// does not make folders anywhere on the person's computer through Coral), and so is a request that came through Coral Hub (its folder is on another computer, whose owner has not seen step 1's line).
func newFolderCallerRefusal(r *http.Request) string {
	if agentCaller(r) || cloud.Tunneled(r) {
		return "Coral makes a new folder only when a person asks for it on this computer"
	}
	return ""
}
