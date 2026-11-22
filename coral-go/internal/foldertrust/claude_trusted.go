package foldertrust

import (
	"encoding/json"
	"os"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"strings"
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
	// Compare in one form: forward slashes, no trailing slash, and on Windows (a case-insensitive disk) lower case, so a key Claude wrote as C:/Users/me/app matches C:\Users\Me\app.
	trusted = false
	seen := map[string]bool{}
	for k, e := range top.Projects {
		if e.Accepted != nil && *e.Accepted {
			seen[trustKey(k)] = true
		}
	}
	for p := trustKey(path); ; {
		if seen[p] {
			return true, true
		}
		parent := pathpkg.Dir(p)
		if parent == p || parent == "." {
			break
		}
		p = parent
	}
	return false, true
}

// trustKey is the form two paths are compared in (see ClaudeTrusted).
func trustKey(p string) string {
	p = filepath.ToSlash(filepath.Clean(filepath.FromSlash(p)))
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}
