package machinelaunch

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// The state file (#10918, coral-hub's request 3): what a launch made, by id, so `coral machine delete` and the clean-up of a failed launch find every piece even when the provider's own list lags or
// the launch was interrupted. It is mode 0600 in a 0700 folder and holds IDS ONLY: no token, no key, no credential, no address. Every field is checked against a narrow shape when it is written and when it is
// read, and a file with a field this version does not know, or a value that looks like a secret, is refused rather than carried along.

// Record is one machine's ids.
type Record struct {
	Name         string    `json:"name"`
	Provider     string    `json:"provider"`
	Region       string    `json:"region"`
	LaunchTag    string    `json:"launch_tag"`
	DropletID    string    `json:"droplet_id,omitempty"`
	VPCID        string    `json:"vpc_id,omitempty"`
	FirewallID   string    `json:"firewall_id,omitempty"`
	SSHKeyID     string    `json:"ssh_key_id,omitempty"`
	CredentialID string    `json:"credential_id,omitempty"` // the id the Hub returned at mint (not the credential): what `delete` revokes the machine's identity by
	Created      time.Time `json:"created"`
}

type stateFile struct {
	Version  int      `json:"version"`
	Machines []Record `json:"machines"`
}

const stateVersion = 1

var (
	idShape       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	launchTagRe   = regexp.MustCompile(`^coral-launch-[0-9a-f]{12}$`)
	providerShape = regexp.MustCompile(`^[a-z][a-z0-9]{1,19}$`)
	// A value that starts like a secret this tool handles is never stored (a provider token, the Hub's key, credential and destroy credential).
	secretPrefixes = []string{"dop_v1_", "do_v1_", "chb_", "chd_", "chk_", "-----BEGIN", "ssh-ed25519", "ssh-rsa", "ecdsa-"}
)

// Validate reports the first thing wrong with a record: a field that is not an id, a name that is not this tool's, or a value that looks like a secret.
func (r Record) Validate() error {
	if !nameShape.MatchString(r.Name) {
		return errors.New("the machine name is not a host name")
	}
	if !providerShape.MatchString(r.Provider) {
		return errors.New("the provider is not a short name")
	}
	if !slugRe.MatchString(r.Region) {
		return errors.New("the region is not a slug")
	}
	if !launchTagRe.MatchString(r.LaunchTag) {
		return errors.New("the launch tag is not one this tool makes")
	}
	for name, v := range map[string]string{"droplet": r.DropletID, "VPC": r.VPCID, "firewall": r.FirewallID, "ssh key": r.SSHKeyID, "credential": r.CredentialID} {
		if v == "" {
			continue
		}
		if !idShape.MatchString(v) {
			return fmt.Errorf("the %s id is not an id", name)
		}
		for _, p := range secretPrefixes {
			if strings.HasPrefix(strings.ToLower(v), strings.ToLower(p)) {
				return fmt.Errorf("the %s id looks like a secret: the state file holds ids only", name)
			}
		}
	}
	return nil
}

// State is the state file, read and written under a lock.
type State struct {
	path string
	mu   sync.Mutex
	recs map[string]Record
}

// ErrUnsafeStateFile is a state file this tool will not read.
var ErrUnsafeStateFile = errors.New("state file is not safe to use")

// OpenState reads the state file at path (none yet is an empty state). A file that is not a regular file of yours, is readable by others (on a system with modes), has a field it does not know or holds
// a value that is not an id is refused.
func OpenState(path string) (*State, error) {
	if path == "" {
		return nil, errors.New("no state file path")
	}
	s := &State{path: path, recs: map[string]Record{}}
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, fmt.Errorf("%w: %s cannot be checked", ErrUnsafeStateFile, path)
	case !fi.Mode().IsRegular():
		return nil, fmt.Errorf("%w: %s is not a regular file (a symlink is not followed)", ErrUnsafeStateFile, path)
	case runtime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0:
		return nil, fmt.Errorf("%w: %s is readable by others: run chmod 600 on it", ErrUnsafeStateFile, path)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%w: %s cannot be read", ErrUnsafeStateFile, path)
	}
	var f stateFile
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("%w: %s is not a state file this version reads (%v)", ErrUnsafeStateFile, path, err)
	}
	if f.Version != stateVersion {
		return nil, fmt.Errorf("%w: %s is version %d, this tool reads version %d", ErrUnsafeStateFile, path, f.Version, stateVersion)
	}
	for _, r := range f.Machines {
		if err := r.Validate(); err != nil {
			return nil, fmt.Errorf("%w: %s: %v", ErrUnsafeStateFile, path, err)
		}
		s.recs[r.Name] = r
	}
	return s, nil
}

// Records are the machines in the file, by name.
func (s *State) Records() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Record, 0, len(s.recs))
	for _, r := range s.recs {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get returns the record of a machine.
func (s *State) Get(name string) (Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.recs[name]
	return r, ok
}

// Put adds or replaces a machine's record and writes the file.
func (s *State) Put(r Record) error {
	if err := r.Validate(); err != nil {
		return fmt.Errorf("not written to the state file: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, had := s.recs[r.Name]
	s.recs[r.Name] = r
	if err := s.saveLocked(); err != nil {
		if had {
			s.recs[r.Name] = prev
		} else {
			delete(s.recs, r.Name)
		}
		return err
	}
	return nil
}

// Remove drops a machine's record (one that is not there is fine) and writes the file.
func (s *State) Remove(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, had := s.recs[name]
	if !had {
		return nil
	}
	delete(s.recs, name)
	if err := s.saveLocked(); err != nil {
		s.recs[name] = prev
		return err
	}
	return nil
}

// saveLocked writes the whole file through a private temporary file in the same folder and a rename, so a crash leaves the old file or the new one, never half of one. The folder is made 0700.
func (s *State) saveLocked() error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("could not make the folder of the state file: %w", err)
	}
	f := stateFile{Version: stateVersion, Machines: make([]Record, 0, len(s.recs))}
	for _, r := range s.recs {
		f.Machines = append(f.Machines, r)
	}
	sort.Slice(f.Machines, func(i, j int) bool { return f.Machines[i].Name < f.Machines[j].Name })
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".machines-*.tmp")
	if err != nil {
		return fmt.Errorf("could not write the state file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}
