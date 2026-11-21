package foldertrust

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ClaudeTrusted says whether Claude's settings file at cfg already trusts path or a folder above it (a read, for the launch's setup check, #20388): Claude asks nothing in a folder it has been told to trust.
// known is false when the file is missing, not a regular file, unreadable or not what Claude writes: the check then says "not checked", never "trusted". Nothing is written and no value is returned but the answer.
func ClaudeTrusted(cfg, path string) (trusted, known bool) {
	fi, err := os.Lstat(cfg)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > 8<<20 {
		return false, false
	}
	raw, err := os.ReadFile(cfg)
	if err != nil {
		return false, false
	}
	var top struct {
		Projects map[string]struct {
			Accepted *bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	if json.Unmarshal(raw, &top) != nil || top.Projects == nil {
		return false, false
	}
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		if e, ok := top.Projects[p]; ok && e.Accepted != nil && *e.Accepted {
			return true, true
		}
		if parent := filepath.Dir(p); parent == p {
			break
		}
	}
	return false, true
}
