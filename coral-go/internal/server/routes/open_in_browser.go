package routes

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/executil"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/safefs"
)

var openFileInBrowser = executil.OpenFileInBrowser

// The sole local Operator is one person even across cookies/tabs. One request
// can launch at a time, five attempts per minute; refusing never starts a process.
var browserOpens = struct {
	sync.Mutex
	since time.Time
	count int
	busy  bool
}{}

func claimBrowserOpen() bool {
	browserOpens.Lock()
	defer browserOpens.Unlock()
	if time.Since(browserOpens.since) >= time.Minute {
		browserOpens.since = time.Now()
		browserOpens.count = 0
	}
	if browserOpens.busy || browserOpens.count >= 5 {
		return false
	}
	browserOpens.busy = true
	browserOpens.count++
	return true
}
func releaseBrowserOpen() { browserOpens.Lock(); browserOpens.busy = false; browserOpens.Unlock() }

// Check the original components before Resolve canonicalizes them; no symlink,
// dotfile, parent escape or network path becomes an alternate launch path.
func browserPathWithoutLinks(root, path string) bool {
	if safefs.IsUNC(path) {
		return false
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return false
	}
	cur := root
	for _, c := range strings.Split(rel, string(os.PathSeparator)) {
		if strings.HasPrefix(c, ".") {
			return false
		}
		cur = filepath.Join(cur, c)
		fi, err := os.Lstat(cur)
		if err != nil || fi.Mode()&os.ModeSymlink != 0 {
			return false
		}
	}
	return true
}
func browserFileExtension(p string) bool {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".html", ".htm", ".svg":
		return true
	}
	return false
}

// OpenInBrowser is a local Operator power, independently of all route guards.
// POST /api/sessions/live/{name}/open-in-browser {filepath,session_id}
func (h *SessionsHandler) OpenInBrowser(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) || !auth.IsDirectLocal(r) {
		errForbidden(w, "Files can only be opened by the person on this computer")
		return
	}
	// Signed CLI, API keys and Hub-owner identities are not dashboard clicks.
	kind, _ := r.Context().Value(callerKindKey{}).(string)
	if kind != callerDashCookie && kind != callerDashNoCookie {
		errForbidden(w, "Open the file from this computer's dashboard")
		return
	}
	var body struct {
		Filepath  string `json:"filepath"`
		SessionID string `json:"session_id"`
	}
	if decodeJSON(r, &body) != nil {
		errBadRequest(w, "Invalid JSON")
		return
	}
	decoded, err := url.PathUnescape(body.Filepath)
	if err != nil {
		decoded = body.Filepath
	} // an ordinary local filename may contain a literal percent
	if decoded == "" || strings.IndexFunc(decoded, unicode.IsControl) >= 0 {
		errBadRequest(w, "File cannot be opened")
		return
	}
	name := chi.URLParam(r, "name")
	if !h.requireAgentSession(w, r, name, body.SessionID) {
		return
	}
	f, err := h.resolveFileRefPolicy(agentCtx(r), name, body.SessionID, body.Filepath, true, true)
	if err != nil || !browserFileExtension(f.abs) {
		errBadRequest(w, "File cannot be opened")
		return
	}
	root := strings.TrimSuffix(f.abs, filepath.FromSlash(f.rel))
	root = strings.TrimSuffix(root, string(os.PathSeparator))
	held, err := safefs.OpenRoot(root)
	if err != nil {
		errBadRequest(w, "File cannot be opened")
		return
	}
	defer held.Close()
	file, info, err := held.Open(f.rel)
	if err != nil {
		errBadRequest(w, "File cannot be opened")
		return
	}
	defer file.Close()
	// http.StatusTooManyRequests is sent only through the marked action-limit helper.
	if !claimBrowserOpen() {
		httputil.WriteActionLimit(w, 60, "browser_open_limit", "Wait before opening another file in your browser")
		return
	}
	defer releaseBrowserOpen()
	// Re-check immediately before the external browser opens the canonical path.
	now, err := os.Lstat(f.abs)
	if err != nil || !now.Mode().IsRegular() || !os.SameFile(info, now) || !browserPathWithoutLinks(root, f.abs) {
		errBadRequest(w, "File cannot be opened")
		return
	}
	if err := openFileInBrowser(f.abs); err != nil { // helper errors are plain constants, never paths
		errBadRequest(w, err.Error())
		return
	}
	recordHubOperatorAction(r.Context(), h.bs, "this computer", "EVENT", "Opened in browser: "+f.rel, "", http.StatusOK)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
