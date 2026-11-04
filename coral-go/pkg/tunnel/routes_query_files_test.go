package tunnel

import (
	"strings"
	"testing"
)

// #13127: live and manual are the Refresh and Turn on live updates flags of the POST refresh (the Interact tier); the GET read of the same files (View) must not let them through the tunnel, and the POST keeps its
// worktree and both flags.
func TestFilesRoutesQueryRowsKeepRefreshFlagsOnThePostOnly(t *testing.T) {
	has := func(row, name string) bool {
		for _, p := range strings.Split(row, ",") {
			if strings.TrimSuffix(p, "*") == name {
				return true
			}
		}
		return false
	}
	get, post := routeQueries["GET /api/sessions/live/{}/files"], routeQueries["POST /api/sessions/live/{}/files/refresh"]
	for _, name := range []string{"live", "manual"} {
		if has(get, name) {
			t.Errorf("GET .../files lets %q through the tunnel (%q): a View grantee could resume a paused folder or force git", name, get)
		}
		if !has(post, name) {
			t.Errorf("POST .../files/refresh does not let %q through (%q): Refresh and Turn on live updates would be refused through the Hub", name, post)
		}
	}
	if !has(get, "session_id") || !has(get, "worktree") {
		t.Errorf("GET .../files lost its own parameters: %q", get)
	}
	if !has(post, "worktree") {
		t.Errorf("POST .../files/refresh lost worktree=follow: %q", post)
	}
}
