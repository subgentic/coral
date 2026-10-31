package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	router   http.Handler
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
	router.Put("/api/sessions/live/{name}/file-content", handler.SaveFileContent)
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
	return &followRig{t: t, router: router, server: server, handler: handler, sid: sid, name: name, launch: launch, worktree: worktree}
}

func (r *followRig) event(tool string, detail map[string]any) {
	r.t.Helper()
	b, _ := json.Marshal(detail)
	dj, sid := string(b), r.sid
	// the event's agent name is the live row's (what the events route stores: the agent's own name), not the tmux session name the panel's URL carries: the two differ for a real agent
	_, err := r.handler.ts.InsertAgentEvent(context.Background(), &store.AgentEvent{AgentName: "proj", SessionID: &sid, EventType: "tool_use", ToolName: &tool, Summary: "Ran: " + tool, DetailJSON: &dj})
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

// A name and a session id that do not belong together give no worktree (Security's #137549): the panel of agent A cannot be made to follow agent B's worktree by naming B's session, and a Hub viewer
// cannot ask about a session the URL does not name.
func TestAMismatchedNameAndSessionGiveNoWorktree(t *testing.T) {
	r := newFollowRig(t, true)
	const otherSid = "00000000-0000-0000-0000-0000000b1351"
	otherName := "claude-" + otherSid
	require.NoError(t, r.handler.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: otherSid, AgentType: "claude", AgentName: "other", WorkingDir: r.launch}))
	b, _ := json.Marshal(map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	dj, tool, sid := string(b), "Edit", otherSid
	_, err := r.handler.ts.InsertAgentEvent(context.Background(), &store.AgentEvent{AgentName: "other", SessionID: &sid, EventType: "tool_use", ToolName: &tool, Summary: "Ran: Edit", DetailJSON: &dj})
	require.NoError(t, err)

	get := func(urlName, session string) map[string]any {
		req, err := http.NewRequest(http.MethodGet, r.server.URL+"/api/sessions/live/"+urlName+"/files?session_id="+session+"&worktree=follow", nil)
		require.NoError(t, err)
		req.Header.Set("Origin", r.server.URL)
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&body)
		return body
	}
	assert.NotNil(t, get(otherName, otherSid)["worktree"], "the session named by its own URL is followed")
	assert.Nil(t, get(r.name, otherSid)["worktree"], "agent A's URL with agent B's session id follows nothing")
	assert.Nil(t, get(otherName, r.sid)["worktree"], "nor the other way round")
}

// A signed-in page on another address, a phone on the network (the operator's way in), is followed too (Security's #137650): a valid sign-in cookie, a same-origin fetch, an accepted Host, no Bearer, no tunnel
// stamp, not an agent. Its bounds stay strict, with the worktree as the root. The requests are made straight to the router, from a non-loopback peer, as a LAN page's are.
func (r *followRig) lan(method, target, body string, shape func(*http.Request)) *httptest.ResponseRecorder {
	r.t.Helper()
	req := httptest.NewRequest(method, "http://192.168.86.39:8452"+target, strings.NewReader(body))
	req.RemoteAddr = "192.168.86.40:5555"
	req.Header.Set("Origin", "http://192.168.86.39:8452")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	if shape != nil {
		shape(req)
	}
	rec := httptest.NewRecorder()
	r.router.ServeHTTP(rec, req)
	return rec
}

func (r *followRig) lanList(shape func(*http.Request)) map[string]any {
	r.t.Helper()
	rec := r.lan(http.MethodGet, "/api/sessions/live/"+r.name+"/files?session_id="+r.sid+"&worktree=follow", "", shape)
	require.Equal(r.t, http.StatusOK, rec.Code, rec.Body.String())
	var body map[string]any
	require.NoError(r.t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body
}

func TestASignedInPageOnAnotherAddressIsFollowedWithStrictBoundsAndTheWorktreeAsRoot(t *testing.T) {
	r := newFollowRig(t, true)
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	body := r.lanList(nil)
	assert.Equal(t, []string{"work.txt"}, filepaths(body), "the LAN page follows")
	wt, _ := body["worktree"].(map[string]any)
	require.NotNil(t, wt)
	assert.Equal(t, true, wt["followed"])

	// strict bounds with the worktree as the root: its file is read, a path out of it is not
	rec := r.lan(http.MethodGet, "/api/sessions/live/"+r.name+"/file-content?session_id="+r.sid+"&worktree=follow&filepath=work.txt", "", nil)
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "the agent's work")
	for _, out := range []string{"../main-repo/README.md", filepath.Join(r.launch, "README.md"), "../../etc/passwd"} {
		rec = r.lan(http.MethodGet, "/api/sessions/live/"+r.name+"/file-content?session_id="+r.sid+"&worktree=follow&filepath="+out, "", nil)
		assert.NotEqual(t, http.StatusOK, rec.Code, "%s is outside the worktree root: %s", out, rec.Body.String())
	}
}

func TestAPageThatIsNotASignedInSameOriginPersonsIsNotFollowedOnAnotherAddress(t *testing.T) {
	r := newFollowRig(t, true)
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	for name, shape := range map[string]func(*http.Request){
		"no valid sign-in (this computer's browser, no cookie)": func(req *http.Request) {
			*req = *req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashNoCookie))
		},
		"a script (no kind)": func(req *http.Request) {
			*req = *req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerLocalOther))
		},
		"a bearer credential":      func(req *http.Request) { req.Header.Set("Authorization", "Bearer abc") },
		"an API key":               func(req *http.Request) { req.Header.Set("X-API-Key", "k") },
		"a Hub stamp":              func(req *http.Request) { req.Header.Set(tunnel.ViaHeader, "1") },
		"an agent's session token": func(req *http.Request) { req.Header.Set(store.SessionTokenHeader, "tok") },
		"a cross-site page": func(req *http.Request) {
			req.Header.Set("Origin", "https://evil.example")
			req.Header.Set("Sec-Fetch-Site", "cross-site")
		},
		"no origin at all": func(req *http.Request) { req.Header.Del("Origin"); req.Header.Del("Sec-Fetch-Site") },
	} {
		body := r.lanList(shape)
		assert.Empty(t, filepaths(body), "%s: the launch folder's list", name)
		assert.Nil(t, body["worktree"], "%s: no worktree is named", name)
	}
}

// A cross-site write with a valid cookie is not followed into the worktree: the save lands, if at all, where the launch folder's own rules put it, never in the worktree.
func TestACrossSiteWriteIsNotFollowedIntoTheWorktree(t *testing.T) {
	r := newFollowRig(t, true)
	r.event("Edit", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	before, err := os.ReadFile(filepath.Join(r.worktree, "work.txt"))
	require.NoError(t, err)
	rec := r.lan(http.MethodPut, "/api/sessions/live/"+r.name+"/file-content?session_id="+r.sid+"&worktree=follow&filepath=work.txt", `{"content":"overwritten by another site"}`, func(req *http.Request) {
		req.Header.Set("Origin", "https://evil.example")
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		req.Header.Set("Content-Type", "application/json")
	})
	after, err := os.ReadFile(filepath.Join(r.worktree, "work.txt"))
	require.NoError(t, err)
	assert.Equal(t, string(before), string(after), "the worktree's file is untouched (status %d: %s)", rec.Code, rec.Body.String())
}
