// Package heavy is the receiving side of running a heavy command on another machine (#13719 step 2, #13750): a run folder that is made and removed in one place, an extractor that trusts nothing in the archive, an environment
// that is an allowlist, and the wrapper that runs the command and returns its exit code. The mini's account is restricted to the wrapper (a forced command), so the wrapper is the boundary: everything it reads, the header and
// the archive, is hostile input (Security, #13746, #13752).
package heavy

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

var (
	// ErrBadRun is an agent or run id that is not the shape Coral makes, or a folder that is not a real folder where one should be.
	ErrBadRun = errors.New("heavy: not a run folder Coral makes")
	// ErrExists is a run folder that is already there: a stream never writes into another run's folder.
	ErrExists = errors.New("heavy: the run folder already exists")
	// ErrUnsafe is an archive entry or link that could leave the run folder or is not a plain file or folder.
	ErrUnsafe = errors.New("heavy: unsafe archive entry")
	// ErrTooBig is an archive over the file or byte cap.
	ErrTooBig = errors.New("heavy: the archive is over the cap")
)

var (
	agentRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`) // the resource-name pattern's lower-case shape: a slug of the agent's name, made by the client
	runRe   = regexp.MustCompile(`^[0-9a-f]{32}$`)            // 32 lower-case hex: random, made by the client
)

// ValidAgent and ValidRun say whether a name is of the shape the run folder takes.
func ValidAgent(s string) bool { return agentRe.MatchString(s) }
func ValidRun(s string) bool   { return runRe.MatchString(s) }

// RunDir is the one place the run folder is built: root/<agent>/<run>, both parts checked.
func RunDir(root, agent, run string) (string, error) {
	if root == "" || !ValidAgent(agent) || !ValidRun(run) {
		return "", ErrBadRun
	}
	return filepath.Join(root, agent, run), nil
}

// realDir is whether path is a real directory, not a link to one.
func realDir(path string) bool {
	fi, err := os.Lstat(path)
	return err == nil && fi.Mode().IsDir() && fi.Mode()&os.ModeSymlink == 0
}

// MakeRunDir makes root (0700), root/<agent> (0700) and root/<agent>/<run> with a plain mkdir that fails when it is there, so nothing a stream says can write into another run's folder. A link anywhere on the way is refused.
func MakeRunDir(root, agent, run string) (string, error) {
	dir, err := RunDir(root, agent, run)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return "", err
	}
	if !realDir(root) {
		return "", fmt.Errorf("%w: the root is not a real folder", ErrBadRun)
	}
	ad := filepath.Join(root, agent)
	if err := os.Mkdir(ad, 0o700); err != nil && !os.IsExist(err) {
		return "", err
	}
	if !realDir(ad) {
		return "", fmt.Errorf("%w: the agent folder is not a real folder", ErrBadRun)
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		if os.IsExist(err) {
			return "", ErrExists
		}
		return "", err
	}
	return dir, nil
}

// RemoveRun deletes exactly root/<agent>/<run>: both parts are checked, the root, the agent folder and the run folder must each be a real folder (never a link out of the root), and nothing is followed.
func RemoveRun(root, agent, run string) error {
	dir, err := RunDir(root, agent, run)
	if err != nil {
		return err
	}
	if !realDir(root) || !realDir(filepath.Join(root, agent)) || !realDir(dir) {
		return fmt.Errorf("%w: not a real folder on the way", ErrBadRun)
	}
	return os.RemoveAll(dir) // RemoveAll does not follow links
}

// Janitor removes the run folders under root that are older than age (by their modification time), and only folders of the form Coral makes: a killed run leaves nothing for long. It returns how many it removed.
func Janitor(root string, now time.Time, age time.Duration) int {
	if !realDir(root) {
		return 0
	}
	agents, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	n := 0
	for _, a := range agents {
		if !ValidAgent(a.Name()) || !realDir(filepath.Join(root, a.Name())) {
			continue
		}
		runs, err := os.ReadDir(filepath.Join(root, a.Name()))
		if err != nil {
			continue
		}
		for _, r := range runs {
			p := filepath.Join(root, a.Name(), r.Name())
			if !ValidRun(r.Name()) || !realDir(p) {
				continue
			}
			if fi, err := os.Lstat(p); err == nil && now.Sub(fi.ModTime()) > age {
				if os.RemoveAll(p) == nil {
					n++
				}
			}
		}
	}
	return n
}
