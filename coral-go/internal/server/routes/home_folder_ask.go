package routes

import (
	"net/http"
	"os"
	"path/filepath"

	"github.com/subgentic/coral/internal/safefs"
)

// An agent started or woken in the user's home folder itself sees every file of it: the person is asked once, with "Launch anyway" (#13425, from #13422's Security Reviewer, which came back at Claude's
// trust dialog for the home folder). A question, never a refusal: the person's second request names confirm_home_folder and goes through, and every other caller (an agent, the command line, a script, the API key) and
// every other folder is untouched.
const (
	homeFolderCode    = "home_folder"
	homeFolderMessage = "This agent will work in your whole home folder; pick a project folder?"
)

// dashboardCaller reports whether a request comes from the dashboard (signed in, this computer's browser, or Coral Hub through its tunnel): the callers with a screen to answer the question on.
func dashboardCaller(r *http.Request) bool {
	switch kind, _ := r.Context().Value(callerKindKey{}).(string); kind {
	case callerDashCookie, callerDashNoCookie, callerHub:
		return true
	}
	return false
}

// isHomeFolder reports whether dir is the user's home folder itself (links resolved on both sides), not a folder inside it.
func isHomeFolder(dir string) bool {
	if dir == "" {
		return false
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return false
	}
	a, errA := safefs.Resolve(filepath.Clean(dir))
	b, errB := safefs.Resolve(filepath.Clean(home))
	return errA == nil && errB == nil && a == b
}

// askAboutHomeFolder answers 409 home_folder, and reports true, when a dashboard request would start an agent in the home folder itself and the person has not confirmed.
func askAboutHomeFolder(w http.ResponseWriter, r *http.Request, dir string, confirmed bool) bool {
	if confirmed || !dashboardCaller(r) || !isHomeFolder(dir) {
		return false
	}
	writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": homeFolderMessage, "code": homeFolderCode, "message": homeFolderMessage, "working_dir": dir})
	return true
}
