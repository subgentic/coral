package opencode

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/secfile"
)

// What Coral keeps for an agent, all under the opencode data folder and all named by its key: servers/<key> (its own session store, the opencode.db), stores/agents/<key> (the newest session it named),
// stores/last/<key> (its newest message, redacted) and the pointer files stores/<session id> that say which store a session is in. A SLEEPING agent keeps them all (it wakes and picks its session up); a DELETED one
// keeps none (Forget, #11405). An agent that is only ENDED keeps all of it too (Resume of a past chat finds its conversation there): Forget is for the person's own "delete this past chat", which does not exist yet, so nothing
// calls it.

// errLinked is a path of the agent's records that is a link (or not the kind of thing it should be): it is not followed and not removed, and is reported.
var errLinked = errors.New("opencode: a record's path is a link or not what Coral made; left alone")

// errForgotten is the answer to a start or a read for an agent that was deleted.
var errForgotten = errors.New("opencode: the agent was deleted")

// maxPointerScan bounds how many entries of the stores folder are looked at for pointers to a key.
const maxPointerScan = 50000

// Forget ends the agent's server, if one is up, and removes every record Coral keeps for it: its session store, the stored newest session, the kept newest message and the pointers to its store. For an agent
// that was DELETED, never for one that sleeps. Every removal goes through contained paths that are never followed through a link: a link is left where it is and named in the error. Nothing is written for the key
// afterwards: its server cannot be started again, and a history read of it finds nothing.
func (m *Manager) Forget(key string) error {
	if !keyRe.MatchString(key) {
		return fmt.Errorf("opencode: not an agent key: %q", key)
	}
	if m.cfg.DataDir == "" { // as Start: with no folder every removal below would run relative to the working folder (#11608)
		return errors.New("opencode: a data folder is needed to forget an agent")
	}
	m.mu.Lock()
	if m.forgotten == nil || len(m.forgotten) >= 4096 { // keys are ids that are never reused: the set only has to outlast a start or a read already under way
		m.forgotten = map[string]bool{}
	}
	m.forgotten[key] = true
	st := m.starting[key]
	m.mu.Unlock()
	if st != nil { // a server on its way up: let it be published, then stop it
		select {
		case <-st.done:
		case <-time.After(30 * time.Second):
		}
	}
	m.Stop(key)
	return removeRecords(m.cfg.DataDir, key)
}

// isForgotten says the key's agent was deleted: no server is started for it and no history is read.
func (m *Manager) isForgotten(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.forgotten[key]
}

// removeRecords removes the records of key under dataDir; errors are joined, and one failure does not stop the rest.
func removeRecords(dataDir, key string) error {
	var errs []error
	for _, rel := range [][]string{{"stores", "last", key}, {"stores", "agents", key}, {"servers", key}} {
		if err := removeContained(dataDir, rel...); err != nil {
			errs = append(errs, err)
		}
	}
	if err := removePointers(dataDir, key); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// removeContained removes the file or folder at dataDir/rel..., after each folder on the way down is looked at without following links: a link anywhere on it, or a last part that is neither a regular file nor a
// real folder, is errLinked and nothing is removed. A path that is not there is nothing to do.
func removeContained(dataDir string, rel ...string) error {
	cur := dataDir
	for i, part := range rel {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		last := i == len(rel)-1
		switch {
		case fi.Mode()&os.ModeSymlink != 0:
			return fmt.Errorf("%w: %s", errLinked, cur)
		case !last && !fi.IsDir():
			return fmt.Errorf("%w: %s", errLinked, cur)
		case last && fi.IsDir():
			return os.RemoveAll(cur) // RemoveAll does not follow a link inside: it removes the link
		case last && !fi.Mode().IsRegular():
			return fmt.Errorf("%w: %s", errLinked, cur)
		case last:
			return os.Remove(cur)
		}
	}
	return nil
}

// removePointers removes the stores/<session id> files that name key. A file is only read when it is a small regular file (never through a link), and only removed when it names exactly this key.
func removePointers(dataDir, key string) error {
	dir := storesDir(dataDir)
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() {
		if err == nil {
			return fmt.Errorf("%w: %s", errLinked, dir)
		}
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	var errs []error
	seen := 0
	for seen < maxPointerScan {
		names, err := d.Readdirnames(256)
		for _, name := range names {
			seen++
			if !validSessionID(name) {
				continue
			}
			if pointsAt(filepath.Join(dir, name), key) {
				if rerr := os.Remove(filepath.Join(dir, name)); rerr != nil && !errors.Is(rerr, os.ErrNotExist) {
					errs = append(errs, rerr)
				}
			}
		}
		if err != nil { // io.EOF: all read
			if !errors.Is(err, io.EOF) {
				errs = append(errs, err)
			}
			break
		}
	}
	return errors.Join(errs...)
}

// pointsAt says the file at path is a small regular file holding exactly key.
func pointsAt(path, key string) bool {
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > 256 {
		return false
	}
	f, err := secfile.OpenNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 257))
	return err == nil && len(b) <= 256 && strings.TrimSpace(string(b)) == key
}
