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

// The folder cache (QA Reviewer 2's SHOULD on #13079): its expiry on a clock the test moves, a miss that is not kept, the key that keeps agents and follow on/off apart, and the sweep of entries of ended sessions.
func cacheRows(h *SessionsHandler) (n int) {
	h.refreshRoots.Range(func(_, _ any) bool { n++; return true })
	return n
}

func TestTheRefreshFolderCacheExpiresKeepsKeysApartAndSweeps(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	mk := func(sid, dir string) string {
		name := "claude-" + sid
		terminal.addSession(name, dir)
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: dir}))
		return name
	}
	repoA, repoB := t.TempDir(), t.TempDir()
	for _, d := range []string{repoA, repoB} {
		cmd := consoletest.HiddenCommand("git", "-C", d, "init", "-q")
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	nameA := mk("00000000-0000-0000-0000-0000000130e1", repoA)
	nameB := mk("00000000-0000-0000-0000-0000000130e2", repoB)
	var probes atomic.Int64
	gitProbeHook = func() { probes.Add(1) }
	now := time.Now()
	refreshRootNow = func() time.Time { return now }
	t.Cleanup(func() { gitProbeHook = func() {}; refreshRootNow = time.Now })
	ctx := context.Background()
	realA, _ := filepath.EvalSymlinks(repoA)
	realB, _ := filepath.EvalSymlinks(repoB)

	require.Equal(t, realA, handler.refreshWorkdir(ctx, nameA, ""))
	require.Equal(t, realA, handler.refreshWorkdir(ctx, nameA, ""))
	require.EqualValues(t, 1, probes.Load(), "the second ask inside the 5 s is the kept folder")
	now = now.Add(refreshRootTTL - time.Millisecond)
	handler.refreshWorkdir(ctx, nameA, "")
	require.EqualValues(t, 1, probes.Load(), "still kept 1 ms before the end")
	now = now.Add(time.Millisecond)
	handler.refreshWorkdir(ctx, nameA, "")
	require.EqualValues(t, 2, probes.Load(), "at 5 s the folder is resolved again")

	require.Equal(t, realB, handler.refreshWorkdir(ctx, nameB, ""))
	require.EqualValues(t, 3, probes.Load(), "another agent is its own entry")
	require.Equal(t, realA, handler.refreshWorkdir(ctx, nameA, ""))
	require.EqualValues(t, 3, probes.Load(), "and does not disturb the first")
	followCtx := context.WithValue(ctx, followKey{}, true)
	handler.refreshWorkdir(followCtx, nameA, "")
	require.EqualValues(t, 4, probes.Load(), "follow on is a different entry from follow off")
	handler.refreshWorkdir(followCtx, nameA, "")
	require.EqualValues(t, 4, probes.Load())

	require.Equal(t, "", handler.refreshWorkdir(ctx, "claude-no-such-agent", ""), "an agent with no folder resolves to nothing")
	before := probes.Load()
	handler.refreshWorkdir(ctx, "claude-no-such-agent", "")
	require.EqualValues(t, before+1, probes.Load(), "a miss is not kept: the next ask looks again")

	require.Equal(t, 3, cacheRows(handler), "A, B and A with follow")
	now = now.Add(10 * refreshRootTTL) // the sessions ended; a later lookup of one agent sweeps the others
	handler.refreshWorkdir(ctx, nameB, "")
	require.Equal(t, 1, cacheRows(handler), "only the entry just made is kept")
}
