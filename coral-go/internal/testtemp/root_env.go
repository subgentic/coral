package testtemp

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// RootEnv names the folder the private test folders are made in, in place of the system temp folder. The Go tool pays for every stat and open that a test's input log holds outside the
// module by resolving the path's symlinks, and by the time it checks the cache the private folder is gone: the resolution walks the folders that still exist and fails at the first missing
// one, so the cost follows how DEEP the root is (#413). A folder directly in the user's profile is shallower than the temp folder.
//
// It is only ever set by a person's own wrapper or by the Makefile, never by default in code, and it is used only if all of this holds (Security, #6584); otherwise it is ignored, with one line
// on stderr that says why:
//   - an absolute path on a local drive, not a network path;
//   - not a drive root, and not the profile folder itself: it is a folder DIRECTLY in the profile folder, so no other account can create it first and swap what is below it;
//   - its last name is rootName, picked by this tool and not by the caller;
//   - if it exists, it is a real folder (not a link or junction), owned by this user, whose access list grants no one else besides SYSTEM and Administrators; if it does not, it is made here
//     and kept to this user.
//
// The sweep of old private folders runs only against a root that passed.
const RootEnv = "CORAL_TEST_ROOT"

// rootName is the last name of the root, chosen here.
const rootName = "ct"

func rootFromEnv() string {
	root := os.Getenv(RootEnv)
	if root == "" {
		return ""
	}
	clean, reason := checkRoot(root)
	if reason != "" {
		fmt.Fprintf(os.Stderr, "testtemp: %s is ignored: %s\n", RootEnv, reason)
		return ""
	}
	return clean
}

// checkRoot returns the cleaned root, or why it cannot be used. It may make the folder.
func checkRoot(root string) (clean, reason string) {
	if strings.HasPrefix(root, `\\`) || strings.HasPrefix(root, "//") {
		return "", "it is a network path"
	}
	if !filepath.IsAbs(root) {
		return "", "it is not an absolute path"
	}
	clean = filepath.Clean(root)
	if filepath.Dir(clean) == clean {
		return "", "it is a drive or file system root"
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" || !filepath.IsAbs(home) {
		return "", "the profile folder is not known"
	}
	home = filepath.Clean(home)
	if sameFolder(clean, home) {
		return "", "it is the profile folder itself"
	}
	if filepath.Base(clean) != rootName {
		return "", "its last name is not " + rootName
	}
	if !sameFolder(filepath.Dir(clean), home) {
		// Not in the profile: Windows only, and the root must prove itself (root_strict_windows.go, Security #6656), e.g. D:\coral-team-cache\<you>\ct.
		if reason := checkOutsideRoot(clean); reason != "" {
			return "", "it is not directly in the profile folder, and as a root elsewhere " + reason
		}
		return clean, ""
	}
	// Two passes: parallel test binaries (go test runs one per package) can all see the root missing, and the ones that lose the Mkdir get "exists": they go back to the checks below once, on
	// the folder the winner made, instead of giving up and falling back to the temp folder.
	for attempt := 0; attempt < 2; attempt++ {
		fi, err := os.Lstat(clean)
		switch {
		case err == nil:
			if fi.Mode().Type() != os.ModeDir {
				return "", "it is not a real folder (a file, link or junction)"
			}
			if !ownedByMe(clean, fi) {
				return "", "it is not owned by this user"
			}
			if !ownerOnlyAcl(clean) {
				return "", "its access list grants others"
			}
			return clean, ""
		case os.IsNotExist(err):
			err := os.Mkdir(clean, 0o700)
			if err == nil {
				if _, err := ownerOnly(clean); err != nil || !ownerOnlyAcl(clean) {
					return "", "it could not be kept to this user"
				}
				return clean, ""
			}
			if !os.IsExist(err) {
				return "", "it could not be made"
			}
		default:
			return "", "it could not be read"
		}
	}
	return "", "it could not be made"
}

// sameFolder compares two cleaned paths; Windows and macOS file systems ignore case.
func sameFolder(a, b string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// notProtectedData refuses a resolved root that is, or is inside, the real ~/.coral, that holds a .coral folder, or that is inside the module being tested (the source tree).
func notProtectedData(real string) string {
	inside := func(p, dir string) bool {
		return sameFolder(p, dir) || strings.HasPrefix(strings.ToLower(p), strings.ToLower(dir)+string(filepath.Separator))
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		coral := filepath.Join(home, ".coral")
		if r, err := filepath.EvalSymlinks(coral); err == nil {
			coral = r
		}
		if inside(real, coral) || inside(coral, real) {
			return "it is, or is inside or around, the real ~/.coral folder"
		}
	}
	if _, err := os.Lstat(filepath.Join(real, ".coral")); err == nil {
		return "it holds a .coral folder"
	}
	if wd, err := os.Getwd(); err == nil {
		for d := wd; ; d = filepath.Dir(d) {
			if _, err := os.Stat(filepath.Join(d, "go.mod")); err == nil {
				if r, err := filepath.EvalSymlinks(d); err == nil {
					d = r
				}
				if inside(real, d) {
					return "it is inside the source tree being tested"
				}
				break
			}
			if filepath.Dir(d) == d {
				break
			}
		}
	}
	return ""
}
