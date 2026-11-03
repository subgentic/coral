package tmux

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/logsafe"
)

// A tmux server runs from the file it was started from for as long as it lives, and an upgrade replaces the app bundle's tmux in place. macOS can kill a signed process whose file changed under it,
// with nothing logged, and a server holds every agent's terminal (#12592, #12598: the one concrete suspect for the 2026-11-02 18:23:30 death; unproven). So Coral starts its server from a copy of the bundled
// tmux named by the file's own hash, in its data folder: a new version with a different tmux has a different name and never overwrites the file a running server was started from, and an unchanged tmux
// is reused. A server already running from an older path is not touched: a newer client talks to it as before.
const stagedDir = "tmux-bin"

var (
	stagedMu   sync.Mutex
	stagedBins = map[string]string{} // staged copy -> the bundled tmux's terminfo folder
)

// canRun is whether the copy at path can be run at all: it is started once with -V. A tmux that starts and exits with an error did run (a test's stand-in does that); one the system refuses to start
// (no execute permission, a format or a signature macOS rejects) or kills with a signal did not. A variable so a test can fake a refusal.
var canRun = func(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := exec.CommandContext(ctx, path, "-V").Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() >= 0 {
		return nil
	}
	return err
}

// stageTmux copies the bundled tmux bin into <coralDir>/tmux-bin/tmux-<hash of its contents> (once) and returns the copy's path, or "" when it cannot (the caller keeps using bin). The copy is written
// to a temporary file in the same folder and renamed, so a half-written file never has the name; a folder or file there that is a link is refused.
func stageTmux(coralDir, bin, terminfoDir string) string {
	if coralDir == "" || bin == "" {
		return ""
	}
	src, err := os.ReadFile(bin)
	if err != nil {
		log.Printf("[tmux] staging the bundled tmux: cannot read it: %v", err)
		return ""
	}
	sum := sha256.Sum256(src)
	dir := filepath.Join(coralDir, stagedDir)
	if fi, err := os.Lstat(dir); err == nil && (fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir()) {
		log.Printf("[tmux] staging the bundled tmux: %s is not a plain folder; using the bundled file", logsafe.Path(dir))
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("[tmux] staging the bundled tmux: cannot make its folder: %v", err)
		return ""
	}
	if err := os.Chmod(dir, 0o700); err != nil { // a folder made looser by anything else is made private again: nobody else may swap a file in it
		log.Printf("[tmux] staging the bundled tmux: cannot make its folder private: %v", err)
		return ""
	}
	dst := filepath.Join(dir, "tmux-"+hex.EncodeToString(sum[:8]))
	if fi, err := os.Lstat(dst); err == nil {
		if fi.Mode().IsRegular() && fi.Mode()&0o100 != 0 && fi.Mode()&0o022 == 0 && sameContent(dst, sum) {
			if err := canRun(dst); err != nil {
				log.Printf("[tmux] staging the bundled tmux: its copy %s cannot be run (%v); using the bundled file", logsafe.Path(dst), err)
				return ""
			}
			remember(dst, terminfoDir)
			pruneStaged(dir, dst)
			return dst
		}
		log.Printf("[tmux] staging the bundled tmux: %s is not the copy it should be; using the bundled file", logsafe.Path(dst))
		return ""
	}
	tmp, err := os.CreateTemp(dir, ".stage-")
	if err != nil {
		log.Printf("[tmux] staging the bundled tmux: cannot write: %v", err)
		return ""
	}
	_, werr := tmp.Write(src)
	cerr := tmp.Close()
	if werr == nil && cerr == nil {
		werr = os.Chmod(tmp.Name(), 0o700)
	}
	if werr != nil || cerr != nil {
		os.Remove(tmp.Name())
		log.Printf("[tmux] staging the bundled tmux: cannot write the copy: %v %v", werr, cerr)
		return ""
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		os.Remove(tmp.Name())
		log.Printf("[tmux] staging the bundled tmux: cannot name the copy: %v", err)
		return ""
	}
	if err := canRun(dst); err != nil { // the copy is not used, and not kept: a later start may try again
		os.Remove(dst)
		log.Printf("[tmux] staging the bundled tmux: the new copy cannot be run (%v); using the bundled file", err)
		return ""
	}
	log.Printf("[tmux] the tmux server will start from its own copy of the bundled tmux: %s", logsafe.Path(dst))
	remember(dst, terminfoDir)
	pruneStaged(dir, dst)
	return dst
}

func sameContent(path string, want [32]byte) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false
	}
	var got [32]byte
	copy(got[:], h.Sum(nil))
	return got == want
}

func remember(staged, terminfoDir string) {
	stagedMu.Lock()
	stagedBins[staged] = terminfoDir
	stagedMu.Unlock()
}

// stagedTerminfo is the terminfo folder to use with bin when bin is a copy staged by stageTmux.
func stagedTerminfo(bin string) (string, bool) {
	stagedMu.Lock()
	defer stagedMu.Unlock()
	ti, ok := stagedBins[bin]
	return ti, ok
}
