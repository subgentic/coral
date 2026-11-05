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
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/gitguard"
	"github.com/subgentic/coral/internal/store"
)

// refreshTimeoutRig is a folder of one commit and n new files with its refresh route, for the tests of a pass whose git runs out of time.
type refreshTimeoutRig struct {
	post func(query string) map[string]any
	repo string
}

func newRefreshTimeoutRig(t *testing.T, sid string, newFiles int) *refreshTimeoutRig {
	t.Helper()
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
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
	for i := 0; i < newFiles; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(repo, fmt.Sprintf("n-%d.txt", i)), []byte("x\n"), 0o644))
	}
	name := "claude-" + sid
	terminal.addSession(name, repo)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: repo}))
	post := func(query string) map[string]any {
		t.Helper()
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/"+name+"/files/refresh"+query, bytes.NewBufferString(`{"session_id":"`+sid+`"}`))
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		refreshFlights.mu.Lock() // each ask is its own pass: no stored result of a slow one answers the next
		clear(refreshFlights.recent)
		refreshFlights.mu.Unlock()
		return out
	}
	return &refreshTimeoutRig{post: post, repo: repo}
}

// answerFilePaths is the names of the files in an answer's list.
func answerFilePaths(files any) []string {
	var out []string
	for _, f := range files.([]any) {
		out = append(out, f.(map[string]any)["filepath"].(string))
	}
	return out
}

// git runs out of time for one pass: the 1 ns limit ends every git command at once.
func gitOutOfTime(t *testing.T) {
	t.Helper()
	old := refreshGitTimeout
	refreshGitTimeout = time.Nanosecond
	t.Cleanup(func() { refreshGitTimeout = old })
}

// A refresh whose git runs out of time used to answer an empty list with a count of 0 and wipe the stored list; now it says timed_out, keeps the last good list and its count, and leaves the stored list as it was.
func TestAGitRefreshThatTimesOutSaysSoAndKeepsTheLastList(t *testing.T) {
	rig := newRefreshTimeoutRig(t, "00000000-0000-0000-0000-00000000e4e4", 5)
	first := rig.post("")
	require.Len(t, first["files"], 5)
	require.Equal(t, false, first["timed_out"], "a pass that finished is not timed out")
	require.EqualValues(t, 5, first["total_changed"])

	old := refreshGitTimeout
	gitOutOfTime(t)
	second := rig.post("?manual=1")
	require.Equal(t, true, second["timed_out"], "git ran out of time and the answer says so")
	require.Len(t, second["files"], 5, "the last good list is kept")
	require.EqualValues(t, 5, second["total_changed"], "and its total, not 0")
	require.Equal(t, answerFilePaths(first["files"]), answerFilePaths(second["files"]), "the same files (the stored copy carries its own recorded time)")

	refreshGitTimeout = old
	third := rig.post("?manual=1")
	require.Equal(t, false, third["timed_out"], "the next pass that finishes is not timed out")
	require.Len(t, third["files"], 5, "the stored list was not wiped by the timed out pass")
}

// With no last good list there is nothing to keep: the answer is empty and says why, instead of "0 changed".
func TestAGitRefreshThatTimesOutWithNoLastListIsEmptyAndSaysSo(t *testing.T) {
	rig := newRefreshTimeoutRig(t, "00000000-0000-0000-0000-00000000e5e5", 3)
	gitOutOfTime(t)
	first := rig.post("?manual=1")
	require.Equal(t, true, first["timed_out"])
	require.Len(t, first["files"], 0)
	require.EqualValues(t, 0, first["total_changed"])
}

// On a followed worktree the stored list is the launch folder's, never the worktree's: a pass that times out there keeps nothing until a pass of the worktree's own has finished, and then keeps THAT list,
// instead of showing the launch folder's files as the worktree's last list.
func TestATimedOutRefreshOfAFollowedWorktreeKeepsOnlyItsOwnLastList(t *testing.T) {
	r := newFollowRig(t, true)
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	require.NoError(t, os.WriteFile(filepath.Join(r.launch, "launch-only.txt"), []byte("x\n"), 0o644))
	r.event("Write", map[string]any{"file_path": filepath.Join(r.worktree, "work.txt")})
	post := func(query string) map[string]any {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, r.server.URL+"/api/sessions/live/"+r.name+"/files/refresh?session_id="+r.sid+query, bytes.NewBufferString(`{"session_id":"`+r.sid+`"}`))
		require.NoError(t, err)
		req.Header.Set("Origin", r.server.URL)
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		refreshFlights.mu.Lock()
		clear(refreshFlights.recent)
		refreshFlights.mu.Unlock()
		return out
	}
	plain := post("&manual=1") // stores the launch folder's list
	require.Equal(t, []string{"launch-only.txt"}, filepaths(plain))

	old := refreshGitTimeout
	gitOutOfTime(t)
	followed := post("&worktree=follow&manual=1")
	require.Equal(t, true, followed["timed_out"])
	require.Empty(t, filepaths(followed), "the launch folder's list is not the worktree's last list")
	require.EqualValues(t, 0, followed["total_changed"])

	refreshGitTimeout = old
	own := post("&worktree=follow&manual=1")
	require.Equal(t, false, own["timed_out"])
	require.Equal(t, []string{"work.txt"}, filepaths(own), "the worktree's own pass lists its own file")

	gitOutOfTime(t)
	again := post("&worktree=follow&manual=1")
	require.Equal(t, true, again["timed_out"])
	require.Equal(t, []string{"work.txt"}, filepaths(again), "now the worktree keeps its own last list, still not the launch folder's")
	require.EqualValues(t, 1, again["total_changed"])
	unfollowed := post("&manual=1")
	require.Equal(t, true, unfollowed["timed_out"])
	require.Equal(t, []string{"launch-only.txt"}, filepaths(unfollowed), "the launch folder keeps its own last list")
}
