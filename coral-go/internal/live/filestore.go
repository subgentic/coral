package live

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Open is the gate (design: every slice ships shut). While it is false no route answers and nothing is read or written. Only a reviewed change sets it, and only the Operator's release decision opens it.
var Open = false

// FileStore keeps the links in one file in this computer's data folder: private to this user (0600), written whole to a new file and renamed over the old one. A file that is there but cannot be read is an error, never "no links": a guard must not forget a live link.
type FileStore struct{ Path string }

func (f FileStore) Load() ([]Link, error) {
	b, err := os.ReadFile(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ls []Link
	if err := json.Unmarshal(b, &ls); err != nil {
		return nil, err
	}
	return ls, nil
}

func (f FileStore) Save(ls []Link) error {
	b, err := json.Marshal(ls)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(f.Path), ".live-links-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	return os.Rename(name, f.Path)
}
