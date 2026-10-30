package routes

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// suggestedDirName is the one folder name a launch may ask Coral to create: letters, digits, dot, dash and underscore, no leading dot (#11258 item 3).
var suggestedDirName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$`)

// windowsReserved are the device names Windows refuses as a file or folder name, with or without an extension; they are refused on every platform so a folder made
// here can be opened anywhere.
var windowsReserved = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)`)

// createSuggestedDir makes the folder the dialog suggested for a first agent or team, <home>/Coral/<name>, when the request says create_dir. It makes only that
// exact shape: one plain name directly under a Coral folder in the home folder (or in CORAL_ROOT), and never through a link. Any other path is left to
// launchDirError, so create_dir cannot make a folder anywhere else. It returns "" when nothing is wrong, including when the folder was not asked for.
func createSuggestedDir(dir string, create bool, roots ...string) string {
	if !create || dir == "" {
		return ""
	}
	clean := filepath.Clean(dir)
	name := filepath.Base(clean)
	parent := filepath.Dir(clean)
	if !suggestedDirName.MatchString(name) || strings.HasSuffix(name, ".") || windowsReserved.MatchString(name) {
		return fmt.Sprintf("can't create %s: a folder name takes letters, digits, dots, dashes and underscores, and is not a reserved or dot-ending name", dir)
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
			return fmt.Sprintf("can't create %s: %v", dir, err)
		}
		if fi, err := os.Lstat(coral); err != nil || fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
			return fmt.Sprintf("can't create %s: %s is not a plain folder", dir, coral)
		}
		if err := os.Mkdir(clean, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return fmt.Sprintf("can't create %s: %v", dir, err)
		}
		if fi, err := os.Lstat(clean); err != nil || fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
			return fmt.Sprintf("can't create %s: it is not a plain folder", dir)
		}
		return ""
	}
	return fmt.Sprintf("can't create %s: Coral makes only a folder directly under Coral in your home folder", dir)
}
