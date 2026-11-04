package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/gitguard"
	"github.com/subgentic/coral/internal/store"
)

// #13079, the Operator's far computer: POST files/refresh took 3.3 s every 4 s and the folder was never paused. Finding the repository (its top level, the followed worktree, is-inside-work-tree) ran before the pause check and
// was not counted as slow, so a repository where only that part is slow was neither paused nor spared the git processes.
func refreshProbeRig(t *testing.T) (url, name, sid, repo string) {
	t.Helper()
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Post("/api/sessions/live/{name}/files/refresh", handler.RefreshFiles)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	repo = t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := consoletest.HiddenCommand("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "HOME="+repo)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, "git %v: %s", args, out)
	}
	git("init", "-q")
	git("config", "user.email", "t@example.invalid")
	git("config", "user.name", "t")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "README.md"), []byte("hi\n"), 0o644))
	git("add", "-A")
	git("commit", "-qm", "init")
	sid = "00000000-0000-0000-0000-0000000130d1"
	name = "claude-" + sid
	terminal.addSession(name, repo)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: repo}))
	return server.URL, name, sid, repo
}

func postRefresh(t *testing.T, url, name, sid string) {
	t.Helper()
	forgetRefreshResults() // a cold git pass over refreshReuseOver would be reused by the next ask, which then is not a pass of its own and counts no strike
	req, _ := http.NewRequest("POST", url+"/api/sessions/live/"+name+"/files/refresh", bytes.NewBufferString(`{"session_id":"`+sid+`"}`))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
}

func TestAPausedFolderRunsNoGitForTheRefreshAndTheFolderIsResolvedOncePerFewSeconds(t *testing.T) {
	url, name, sid, repo := refreshProbeRig(t)
	realRepo, err := filepath.EvalSymlinks(repo)
	require.NoError(t, err)
	var probes atomic.Int64
	gitProbeHook = func() { probes.Add(1) }
	t.Cleanup(func() { gitProbeHook = func() {} })
	gitguard.Pause(realRepo, 7, 3*time.Second)
	for i := 0; i < 5; i++ { // the Files panel's poll
		postRefresh(t, url, name, sid)
	}
	require.EqualValues(t, 1, probes.Load(), "five polls of a paused folder: the folder is resolved once and no repository check runs (was 10 git probes)")
	_, paused := gitguard.Get(realRepo)
	require.True(t, paused, "and the folder stays paused")
}

func TestARepositoryWhoseOnlySlowPartIsFindingItIsPausedToo(t *testing.T) {
	url, name, sid, repo := refreshProbeRig(t)
	realRepo, err := filepath.EvalSymlinks(repo)
	require.NoError(t, err)
	oldSlow := gitguard.SlowPass
	t.Cleanup(func() { gitguard.SlowPass = oldSlow })
	gitguard.SlowPass = 300 * time.Millisecond
	gitProbeHook = func() { time.Sleep(400 * time.Millisecond) } // sleep-ok: a slow repository check, the case the Operator's machine showed
	t.Cleanup(func() { gitProbeHook = func() {} })
	postRefresh(t, url, name, sid)
	_, paused := gitguard.Get(realRepo)
	require.False(t, paused, "one slow request is one strike")
	postRefresh(t, url, name, sid)
	_, paused = gitguard.Get(realRepo)
	require.True(t, paused, "two slow requests pause the folder, though the pass itself is fast")
}
