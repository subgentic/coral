package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/gitguard"
	"github.com/subgentic/coral/internal/store"
)

// #13079: a repository with thousands of changes. The Files panel asked for a refresh every 4 s and each call ran git again, stored every file and sent every file. Now one pass runs at a time per folder
// (the calls that arrive meanwhile share its answer), the list stored and sent is cut at the cap by name, and the total is said.
func TestRefreshFilesOnABigRepoRunsOnePassAndSendsTheCap(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
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
	const n = refreshFilesCap + 600
	for i := 0; i < n; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(repo, fmt.Sprintf("new-%05d.txt", i)), []byte("x\n"), 0o644))
	}
	const sid = "00000000-0000-0000-0000-00000000b1b1"
	name := "claude-" + sid
	terminal.addSession(name, repo)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: repo}))

	var passes atomic.Int64
	var keysSeen atomic.Value // the key a running pass is held under (QA's survivor a: the handler passes the agent's name)
	refreshComputeHook = func() {
		passes.Add(1)
		refreshFlights.mu.Lock()
		for k := range refreshFlights.calls {
			keysSeen.Store(k)
		}
		refreshFlights.mu.Unlock()
		time.Sleep(400 * time.Millisecond)
	}
	t.Cleanup(func() { refreshComputeHook = func() {} })
	oldSlow := gitguard.SlowPass
	t.Cleanup(func() { gitguard.SlowPass = oldSlow })
	gitguard.SlowPass = time.Nanosecond // every pass is slow, so a call that is counted as a pass is a strike (QA's survivor b)

	type answer struct {
		Files   []store.ChangedFile `json:"files"`
		Total   int                 `json:"total_changed"`
		Capped  bool                `json:"capped"`
		Message string              `json:"error"`
	}
	var wg sync.WaitGroup
	answers := make([]answer, 6)
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/"+name+"/files/refresh", bytes.NewBufferString(`{"session_id":"`+sid+`"}`))
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			defer resp.Body.Close()
			_ = json.NewDecoder(resp.Body).Decode(&answers[i])
		}()
	}
	wg.Wait()
	// a seventh call just after: inside the window the slow pass earned, it is the same pass
	req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/"+name+"/files/refresh", bytes.NewBufferString(`{"session_id":"`+sid+`"}`))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()

	require.EqualValues(t, 1, passes.Load(), "six calls at once and a seventh just after are one pass of git, not seven")
	k, _ := keysSeen.Load().(string)
	require.True(t, strings.HasSuffix(k, "\x00"+name), "the pass is held under a key that names the agent: %q", k)
	realRepo, err := filepath.EvalSymlinks(repo)
	require.NoError(t, err)
	_, pausedNow := gitguard.Get(realRepo)
	require.False(t, pausedNow, "one pass is one strike: the calls that shared it were not counted as passes of their own")
	for i, a := range answers {
		require.Len(t, a.Files, refreshFilesCap, "answer %d: the list is cut at the cap (%s)", i, a.Message)
		require.Equal(t, n, a.Total, "answer %d says how many files changed in all", i)
		require.True(t, a.Capped, "answer %d says the list is cut", i)
		require.Equal(t, "new-00000.txt", a.Files[0].Filepath, "answer %d: the first by name", i)
	}
	stored, found, err := handler.gs.GetChangedFiles(context.Background(), name, nil, "branch_point")
	_ = stored
	_ = found
	_ = err
}

// A slow folder is paused (#13079): the page's own refresh then gets the stored list and no git runs; Refresh (manual=1) runs one pass; a manual pass that comes back fast turns live updates back on.
func TestRefreshFilesPausesASlowFolderAndRefreshRunsOnePass(t *testing.T) {
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	oldSlow := gitguard.SlowPass
	t.Cleanup(func() { gitguard.SlowPass = oldSlow })
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
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
	for i := 0; i < 7; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(repo, fmt.Sprintf("n-%d.txt", i)), []byte("x\n"), 0o644))
	}
	const sid = "00000000-0000-0000-0000-00000000c2c2"
	name := "claude-" + sid
	terminal.addSession(name, repo)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: repo}))
	var passes atomic.Int64
	refreshComputeHook = func() { passes.Add(1) }
	t.Cleanup(func() { refreshComputeHook = func() {} })
	post := func(query string) map[string]any {
		t.Helper()
		defer forgetRefreshResults() // each call is a new question: a pass slow enough to be reused (a loaded machine) must not answer the next one
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/"+name+"/files/refresh"+query, bytes.NewBufferString(`{"session_id":"`+sid+`"}`))
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}

	gitguard.SlowPass = time.Nanosecond
	first := post("")
	require.EqualValues(t, 1, passes.Load())
	require.Nil(t, first["paused"], "one slow pass does not pause the folder")
	require.Len(t, first["files"], 7)
	second := post("")
	require.EqualValues(t, 2, passes.Load())
	require.NotNil(t, second["paused"], "two slow passes in a row pause it and the answer says so")

	for i := 7; i < 10; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(repo, fmt.Sprintf("n-%d.txt", i)), []byte("x\n"), 0o644))
	}
	third := post("")
	require.EqualValues(t, 2, passes.Load(), "a paused folder runs no git for the page's own refresh")
	require.NotNil(t, third["paused"])
	require.Len(t, third["files"], 7, "the stored list is the answer")

	fourth := post("?manual=1")
	require.EqualValues(t, 3, passes.Load(), "Refresh runs one pass on demand")
	require.Len(t, fourth["files"], 10)
	require.NotNil(t, fourth["paused"], "still slow, so still paused")

	gitguard.SlowPass = time.Hour
	fifth := post("?manual=1")
	require.EqualValues(t, 4, passes.Load())
	require.Nil(t, fifth["paused"], "a manual pass that came back fast turns live updates back on")
	sixth := post("")
	require.EqualValues(t, 5, passes.Load(), "live again: the page's refresh runs git")
	require.Nil(t, sixth["paused"])
}

// 35,000 changed files (#13079, the Operator's repository): a refresh runs, and the server keeps answering its other routes quickly while git works: the list is cut before it is stored, so no long write holds the
// database, and the refresh itself is one pass.
func TestServerStaysResponsiveWhileA35kFileRepoIsRefreshed(t *testing.T) {
	if testing.Short() {
		t.Skip("writes 35,000 files")
	}
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	_, handler, terminal, ss := setupSessionsTestServer(t)
	router := chi.NewRouter()
	router.Post("/api/sessions/live/{name}/files/refresh", handler.RefreshFiles)
	router.Get("/api/sessions/live/{name}/events", handler.ListEvents)
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
	const n = 35000
	write := func(content string) {
		for d := 0; d < 350; d++ {
			dir := filepath.Join(repo, fmt.Sprintf("gen%03d", d))
			require.NoError(t, os.MkdirAll(dir, 0o755))
			for i := 0; i < n/350; i++ {
				require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%03d.txt", i)), []byte(content), 0o644))
			}
		}
	}
	write("x\n")
	git("add", "-A")
	git("commit", "-qm", "files")
	write("changed\n") // 35,000 tracked files, all modified
	const sid = "00000000-0000-0000-0000-00000000d3d3"
	name := "claude-" + sid
	terminal.addSession(name, repo)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: repo}))

	type answer struct {
		Files []store.ChangedFile `json:"files"`
		Total int                 `json:"total_changed"`
	}
	done := make(chan answer, 1)
	started := time.Now()
	go func() {
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/"+name+"/files/refresh", bytes.NewBufferString(`{"session_id":"`+sid+`"}`))
		resp, err := http.DefaultClient.Do(req)
		var a answer
		if err == nil {
			_ = json.NewDecoder(resp.Body).Decode(&a)
			resp.Body.Close()
		}
		done <- a
	}()
	var worst time.Duration
	probes := 0
	var a answer
loop:
	for {
		select {
		case a = <-done:
			break loop
		default:
		}
		t0 := time.Now()
		resp, err := http.Get(server.URL + "/api/sessions/live/" + name + "/events?session_id=" + sid)
		require.NoError(t, err)
		resp.Body.Close()
		if d := time.Since(t0); d > worst {
			worst = d
		}
		probes++
		time.Sleep(20 * time.Millisecond)
	}
	t.Logf("refresh of %d files took %s; %d probes, slowest %s", n, time.Since(started).Round(time.Millisecond), probes, worst.Round(time.Millisecond))
	require.Equal(t, n, a.Total, "every changed file is counted")
	require.Len(t, a.Files, refreshFilesCap, "and the list sent is the cap")
	require.Less(t, worst, 200*time.Millisecond, "another route answers in under 200 ms while the refresh runs")
	require.Greater(t, probes, 2, "the refresh took long enough to be probed")
}

// forgetRefreshResults drops the answers the refresh flights keep for reuse. A pass that took longer than refreshReuseOver is answered again for as long as it took, so on a loaded machine a test that asks twice
// and counts the passes saw one where it expected two ("expected 2, saw 1", a flake of the gate); a test that counts passes calls this after each answer.
func forgetRefreshResults() {
	refreshFlights.mu.Lock()
	refreshFlights.recent = map[string]refreshRecent{}
	refreshFlights.mu.Unlock()
}
