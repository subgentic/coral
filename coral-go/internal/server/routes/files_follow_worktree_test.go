package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #11351 (the operator: "If an agent has switched to a different worktree, it doesn't look like we are following them in the UI"): an agent launched in folder A that works in a git worktree B shows B's
// changes in the Files panel, names B and its branch, and can be sent back to A. The folder is chosen only from folders the agent really used (the files it edited and the folders it cd'd into),
// each a git work tree the file viewer's bounds allow; the home folder is never scanned.
type followRig struct {
	t        *testing.T
	server   *httptest.Server
	handler  *SessionsHandler
	sid      string
	name     string
	launch   string // folder A
	worktree string // folder B, a worktree of A's repository
}

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	out, err := consoletest.HiddenCommand("git", append([]string{"-C", dir, "-c", "user.email=t@t", "-c", "user.name=t"}, args...)...).CombinedOutput()
	require.NoError(t, err, string(out))
}

func newFollowRig(t *testing.T, launchIsGit bool) *followRig {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Get("/api/sessions/live/{name}/files", handler.Files)
	router.Post("/api/sessions/live/{name}/files/refresh", handler.RefreshFiles)
	router.Get("/api/sessions/live/{name}/file-content", handler.GetFileContent)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	base := t.TempDir()
	if real, err := filepath.EvalSymlinks(base); err == nil {
		base = real
	}
	repo := filepath.Join(base, "main-repo")
	require.NoError(t, os.MkdirAll(repo, 0o755))
	gitIn(t, repo, "init", "-q", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "README.md"), []byte("hello\n"), 0o644))
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-q", "-m", "first")
	worktree := filepath.Join(base, "feature-tree")
	gitIn(t, repo, "worktree", "add", "-q", "-b", "feature", worktree)
	require.NoError(t, os.WriteFile(filepath.Join(worktree, "work.txt"), []byte("the agent's work\nsecond line\n"), 0o644))

	launch := repo
	if !launchIsGit {
		launch = filepath.Join(base, "plain-launch")
		require.NoError(t, os.MkdirAll(launch, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(launch, "unrelated.txt"), []byte("x\n"), 0o644))
	}
	const sid = "00000000-0000-0000-0000-000000011351"
	name := "claude-" + sid
	terminal.addSession(name, launch)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: launch}))
	return &followRig{t: t, server: server, handler: handler, sid: sid, name: name, launch: launch, worktree: worktree}
}

func (r *followRig) event(tool string, detail map[string]any) {
	r.t.Helper()
	b, _ := json.Marshal(detail)
	dj, sid, name := string(b), r.sid, r.name
	_, err := r.handler.ts.InsertAgentEvent(context.Background(), &store.AgentEvent{AgentName: name, SessionID: &sid, EventType: "tool_use", ToolName: &tool, Summary: "Ran: " + tool, DetailJSON: &dj})
	require.NoError(r.t, err)
}

func (r *followRig) list(query string) map[string]any {
	r.t.Helper()
	return r.listAs(query, func(req *http.Request) {
		req.Header.Set("Origin", r.server.URL) // the dashboard's own page: a same-origin browser fetch from this host
		req.Header.Set("Sec-Fetch-Site", "same-origin")
	})
}

// listAs reads the list as the caller the shape of the request makes it: the dashboard's page, a script, a request through Coral Hub.
func (r *followRig) listAs(query string, shape func(*http.Request)) map[string]any {
	r.t.Helper()
	req, err := http.NewRequest(http.MethodGet, r.server.URL+"/api/sessions/live/"+r.name+"/files?session_id="+r.sid+query, nil)
	require.NoError(r.t, err)
	shape(req)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(r.t, err)
	defer resp.Body.Close()
	var body map[string]any
	require.NoError(r.t, json.NewDecoder(resp.Body).Decode(&body))
	require.Equal(r.t, http.StatusOK, resp.StatusCode)
	return body
}

func filepaths(body map[string]any) []string {
	var out []string
	files, _ := body["files"].([]any)
	for _, f := range files {
		out = append(out, f.(map[string]any)["filepath"].(string))
	}
	return out
}

func TestTheFilesPanelFollowsTheAgentIntoItsWorktree(t *testing.T) {
	r := newFollowRig(t, true)
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})

	body := r.list("&worktree=follow")
	assert.Equal(t, []string{"work.txt"}, filepaths(body), "the worktree's change, not the launch folder's")
	wt, _ := body["worktree"].(map[string]any)
	require.NotNil(t, wt, "the answer names the worktree: %v", body)
	assert.Equal(t, r.worktree, wt["path"])
	assert.Equal(t, "feature-tree", wt["name"])
	assert.Equal(t, "feature", wt["branch"])
	assert.Equal(t, true, wt["followed"])
	assert.Equal(t, r.launch, wt["launch"], "and the folder it was launched in, for the way back")
}

func TestWithoutFollowingTheLaunchFolderIsShownAndTheWorktreeIsOffered(t *testing.T) {
	r := newFollowRig(t, true)
	r.event("Write", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	for _, q := range []string{"&worktree=launch"} { // a request that does not say is answered as before: the panel always says
		body := r.list(q)
		assert.Empty(t, filepaths(body), "the launch folder has no changes (%q)", q)
		wt, _ := body["worktree"].(map[string]any)
		require.NotNil(t, wt, "the worktree is offered (%q): %v", q, body)
		assert.Equal(t, false, wt["followed"], q)
		assert.Equal(t, "feature-tree", wt["name"], q)
		assert.Equal(t, "feature", wt["branch"], q)
	}
}

func TestAnAgentThatCdsIntoAWorktreeIsFollowedToo(t *testing.T) {
	r := newFollowRig(t, true)
	r.event("Bash", map[string]any{"command": "cd " + r.worktree + " && go test ./..."})
	assert.Equal(t, []string{"work.txt"}, filepaths(r.list("&worktree=follow")))
	r2 := newFollowRig(t, true)
	r2.event("Bash", map[string]any{"command": "git -C " + r2.worktree + " status"})
	assert.Equal(t, []string{"work.txt"}, filepaths(r2.list("&worktree=follow")))
}

// The launch folder is not a git folder (the operator's: a home folder): the worktree is what the panel shows, and the launch folder is not scanned for "recent files".
func TestAWorktreeIsFollowedFromAFolderThatIsNotAGitRepository(t *testing.T) {
	r := newFollowRig(t, false)
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	body := r.list("&worktree=follow")
	assert.Equal(t, []string{"work.txt"}, filepaths(body))
	assert.NotContains(t, body, "is_git", "it is a git folder's answer")
}

// The agent's own folder most recently: nothing to follow. Folders it never used, or that are not git work trees, or that the bounds refuse, are never followed.
func TestOnlyFoldersTheAgentUsedAndTheBoundsAllowAreFollowed(t *testing.T) {
	r := newFollowRig(t, true)
	other := t.TempDir() // a folder that is not a git work tree
	r.event("Edit", map[string]any{"file_path": filepath.Join(other, "x.txt")})
	r.event("Bash", map[string]any{"command": "cd /etc && ls"})
	r.event("Edit", map[string]any{"file_path": "relative/path.txt"})
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.launch, "README.md")}) // the launch folder itself
	body := r.list("&worktree=follow")
	assert.Nil(t, body["worktree"], "nothing to follow: %v", body)

	// Read, Grep and other tools that only look are not "working in" a folder.
	r.event("Read", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	r.event("Grep", map[string]any{"path": r.worktree})
	assert.Nil(t, r.list("&worktree=follow")["worktree"], "looking at a folder is not working in it")

	// The newest edit decides: back in the launch folder, the agent is not followed away.
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	require.NotNil(t, r.list("&worktree=follow")["worktree"])
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.launch, "README.md")})
	assert.Nil(t, r.list("&worktree=follow")["worktree"], "the agent is back in its launch folder")
}

// The home folder is never scanned for a git view, not even by the local dashboard: a plain folder that is, or holds, the home folder lists nothing.
func TestTheHomeFolderIsNeverScannedForRecentFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	require.NoError(t, os.WriteFile(filepath.Join(home, "Downloads.txt"), []byte("x\n"), 0o644))
	assert.Empty(t, recentFilesInPlainFolder(home, false), "the dashboard's own request: the home folder is still not scanned")
	assert.Empty(t, recentFilesInPlainFolder(filepath.Dir(home), false), "nor a folder that holds it")
	sub := filepath.Join(home, "project")
	require.NoError(t, os.MkdirAll(sub, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(sub, "notes.txt"), []byte("x\n"), 0o644))
	assert.Len(t, recentFilesInPlainFolder(sub, false), 1, "a folder inside it is the agent's own")
}

// Only the dashboard's own page is followed (Security's #137514): a request that is not it (a script, an agent's bounded call) or that came through Coral Hub (stamped) asks worktree=follow and is answered
// from the launch folder, with no worktree object. The same holds for the file reads the panel makes.
func TestOnlyTheDashboardIsFollowedIntoAWorktree(t *testing.T) {
	r := newFollowRig(t, true)
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	require.Equal(t, []string{"work.txt"}, filepaths(r.list("&worktree=follow")), "the dashboard is followed")

	for name, shape := range map[string]func(*http.Request){
		"a script (no same-origin page)": func(req *http.Request) {},
		"a request through Coral Hub": func(req *http.Request) {
			req.Header.Set(tunnel.ViaHeader, "1")
			req.Header.Set("Origin", r.server.URL)
			req.Header.Set("Sec-Fetch-Site", "same-origin")
		},
		"a bearer credential": func(req *http.Request) {
			req.Header.Set("Authorization", "Bearer abc")
			req.Header.Set("Origin", r.server.URL)
			req.Header.Set("Sec-Fetch-Site", "same-origin")
		},
	} {
		body := r.listAs("&worktree=follow", shape)
		assert.Empty(t, filepaths(body), "%s: the launch folder's list, which has no changes", name)
		assert.Nil(t, body["worktree"], "%s: and no worktree is named", name)
	}
}
