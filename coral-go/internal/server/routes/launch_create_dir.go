package routes

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// suggestedDirName is the one folder name a launch may ask Coral to create: letters, digits, dot, dash and underscore, no leading dot (#11258 item 3).
var suggestedDirName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$`)

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
	if !suggestedDirName.MatchString(name) || name == "." || name == ".." {
		return fmt.Sprintf("can't create %s: a folder name takes letters, digits, dots, dashes and underscores", dir)
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
		if fi, err := os.Lstat(coral); err == nil && (fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir()) {
			return fmt.Sprintf("can't create %s: %s is not a plain folder", dir, coral)
		}
		if err := os.MkdirAll(clean, 0o755); err != nil {
			return fmt.Sprintf("can't create %s: %v", dir, err)
		}
		return ""
	}
	return fmt.Sprintf("can't create %s: Coral makes only a folder directly under Coral in your home folder", dir)
}
