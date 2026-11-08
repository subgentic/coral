package routes

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/subgentic/coral/internal/foldertrust"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/safefs"
)

// TrustFolderProbe is advice for the dashboard checkbox, never authority to trust.
// Only fixed presence flags leave this handler; file contents are never opened.
func (h *SystemHandler) TrustFolderProbe(w http.ResponseWriter, r *http.Request) {
	if !trustFolderCaller(r) {
		errForbidden(w, "only this computer's dashboard can check folder trust")
		return
	}
	h.trustProbeMu.Lock()
	limited := time.Since(h.trustProbeAt) < 250*time.Millisecond
	if !limited {
		h.trustProbeAt = time.Now()
	}
	h.trustProbeMu.Unlock()
	if limited {
		// A per-action limit, not an overloaded server (#3434): the marker keeps the dashboard's overload watch from pausing its pollers, and the body keeps the dialog's shape ("checked": false).
		httputil.WriteActionLimitBody(w, 1, map[string]any{"checked": false})
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"checked": false})
		return
	}
	writeJSON(w, http.StatusOK, probeProjectTrust(r.URL.Query().Get("path"), home))
}

func probeProjectTrust(path, home string) map[string]any {
	unchecked := map[string]any{"checked": false}
	if len(path) > 4096 || !filepath.IsAbs(path) || safefs.RefuseRemote(path) != nil || strings.IndexFunc(path, unicode.IsControl) >= 0 {
		return unchecked
	}
	for _, part := range strings.FieldsFunc(path, func(c rune) bool { return c == '/' || c == '\\' }) {
		if safefs.CheckName(part) != nil || part == "." || part == ".." {
			return unchecked
		}
	}
	path = filepath.Clean(path) // a trailing separator must not turn Lstat(link/) into a followed link
	fi, err := os.Lstat(path)
	if err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return unchecked
	}
	real, err := foldertrust.Check(path, home, foldertrust.Ticked)
	if err != nil {
		return unchecked
	}
	// Hold the checked directory open. Descendants cannot escape this root, even
	// if a directory is replaced during this bounded, metadata-only probe.
	root, err := os.OpenRoot(real)
	if err != nil {
		return unchecked
	}
	defer root.Close()
	current, err := os.Lstat(path)
	if err != nil || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(fi, current) {
		return unchecked
	}
	found := map[string]bool{}
	groups := map[string][]string{"": {".mcp.json"}, ".claude": {"settings.json", "settings.local.json"}, ".codex": {"config.toml"}}
	for dir, names := range groups {
		at := root
		if dir != "" {
			parent, e := root.Lstat(dir)
			if errors.Is(e, os.ErrNotExist) {
				for _, name := range names {
					found[dir+"/"+name] = false
				}
				continue
			}
			if e != nil || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 {
				return unchecked
			}
			child, e := root.OpenRoot(dir)
			if e != nil {
				return unchecked
			}
			defer child.Close()
			after, e := root.Lstat(dir)
			if e != nil || after.Mode()&os.ModeSymlink != 0 || !os.SameFile(parent, after) {
				return unchecked
			}
			at = child
		}
		for _, name := range names {
			key := name
			if dir != "" {
				key = dir + "/" + name
			}
			entry, e := at.Lstat(name)
			if errors.Is(e, os.ErrNotExist) {
				found[key] = false
				continue
			}
			if e != nil || entry.Mode()&os.ModeSymlink != 0 || !entry.Mode().IsRegular() {
				return unchecked
			}
			found[key] = true
		}
	}
	return map[string]any{"checked": true, "files": found}
}
