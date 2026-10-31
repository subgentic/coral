package testtemp

import (
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// staleAfter is how old a private folder must be before a later run removes it: a test binary that was killed (or crashed) never ran its
// cleanup, and left its folder behind. No package's tests run for a day.
const staleAfter = 24 * time.Hour

// privateName is exactly the name makePrivateFolder gives the private folder: "ct-" and its random digits. Nothing else is touched.
var privateName = regexp.MustCompile(`^ct-[0-9]+$`)

// sweepStale removes, under base (the system temp folder when ""), the private folders earlier runs left: a folder (not a link) named exactly
// as setup names them, last changed more than staleAfter before now, and owned by this user. A folder still in use is held open
// without delete sharing on Windows (hold), so removing it fails there and it stays. Errors are ignored: a folder that can't be removed now
// is tried again by the next run.
func sweepStale(base string, now time.Time) {
	if base == "" {
		base = os.TempDir()
	}
	// Through an os.Root on base: a name that is a link cannot lead the removal out of the root.
	root, err := os.OpenRoot(base)
	if err != nil {
		return
	}
	defer root.Close()
	d, err := root.Open(".")
	if err != nil {
		return
	}
	entries, err := d.ReadDir(-1)
	d.Close()
	if err != nil {
		return
	}
	for _, e := range entries {
		if !privateName.MatchString(e.Name()) {
			continue
		}
		fi, err := root.Lstat(e.Name())
		if err != nil || !fi.IsDir() || now.Sub(fi.ModTime()) < staleAfter || !ownedByMe(filepath.Join(base, e.Name()), fi) {
			continue
		}
		_ = root.RemoveAll(e.Name())
	}
}
