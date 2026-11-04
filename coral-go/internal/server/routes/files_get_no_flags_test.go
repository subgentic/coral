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

// coral-hub's Security on #13127: GET .../files is the View tier's read. live=on and manual=1 are the Refresh and Turn on flags of the POST refresh (Interact): on the GET's fall-through to the refresh they must be
// ignored, so a View grantee can neither resume a paused folder nor force a pass of git. The POST is unchanged.
func TestFilesGetIgnoresTheRefreshFlagsAndThePostStillHonoursThem(t *testing.T) {
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Get("/api/sessions/live/{name}/files", handler.Files)
	router.Post("/api/sessions/live/{name}/files/refresh", handler.RefreshFiles)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	repo := t.TempDir()
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
	require.NoError(t, os.WriteFile(filepath.Join(repo, "new.txt"), []byte("x\n"), 0o644))
	const sid = "00000000-0000-0000-0000-00000000f6f6"
	name := "claude-" + sid
	terminal.addSession(name, repo)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: repo}))
	realRepo, err := filepath.EvalSymlinks(repo)
	require.NoError(t, err)
	var passes atomic.Int64
	refreshComputeHook = func() { passes.Add(1) }
	t.Cleanup(func() { refreshComputeHook = func() {} })

	gitguard.Pause(realRepo, 7, 3*time.Second)
	get := func(query string) *http.Response {
		t.Helper()
		resp, err := http.Get(server.URL + "/api/sessions/live/" + name + "/files?session_id=" + sid + query)
		require.NoError(t, err)
		resp.Body.Close()
		return resp
	}
	for _, q := range []string{"&live=on", "&manual=1", "&live=on&manual=1"} {
		get(q)
		_, paused := gitguard.Get(realRepo)
		require.True(t, paused, "GET %s on a paused folder leaves it paused (a View grantee cannot resume it)", q)
		require.EqualValues(t, 0, passes.Load(), "GET %s runs no pass of git (a View grantee cannot force one)", q)
	}

	post := func(query string) {
		t.Helper()
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/"+name+"/files/refresh"+query, bytes.NewBufferString(`{"session_id":"`+sid+`"}`))
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
	}
	post("?manual=1")
	require.EqualValues(t, 1, passes.Load(), "the POST with manual=1 runs a pass, as before")
	_, paused := gitguard.Get(realRepo)
	require.False(t, paused, "a fast manual pass turns live updates back on")
	gitguard.Pause(realRepo, 7, 3*time.Second)
	post("?live=on")
	_, paused = gitguard.Get(realRepo)
	require.False(t, paused, "the POST with live=on resumes, as before")
}
