package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/store"
)

// #21468 (mocks v3 idea 3): "stop --remove-worktree" removes only the worktree a worker was started in with its own flag, only when it is clean, never forces, never deletes the branch, and says why when it keeps it.
func (r *orchRig) taskWorktree(member string, task int64) (repo, path string) {
	r.t.Helper()
	repo = realOf(r.t, worktreeRepo(r.t))
	name := taskWorktreeName(task)
	path = filepath.Join(defaultWorktreeDir(repo), name)
	require.NoError(r.t, os.MkdirAll(filepath.Dir(path), 0o755))
	_, err := gitutil.AddTeamWorktree(context.Background(), repo, path, name, "main")
	require.NoError(r.t, err)
	require.NoError(r.t, r.ss.SetTaskWorktree(context.Background(), store.TaskWorktree{SessionID: r.sid[member], TaskID: task, Name: name, Path: path, Repo: repo}))
	return repo, path
}

func (r *orchRig) stopWith(member string, remove bool) (int, map[string]any) {
	body := ""
	if remove {
		body = `{"remove_worktree": true}`
	}
	return r.agentPost("Orchestrator", "stop", member, body)
}

func (r *orchRig) grantedStop() {
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"stop_enabled": true})
	require.Equal(r.t, 200, code)
}

func wtOf(out map[string]any) map[string]any { m, _ := out["worktree"].(map[string]any); return m }

func TestStopRemovesAWorkersOwnCleanWorktreeAndKeepsItsBranch(t *testing.T) {
	r := newOrchRig(t)
	r.grantedStop()
	repo, path := r.taskWorktree("Dev2", 412)
	code, out := r.stopWith("Dev2", true)
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "removed", wtOf(out)["state"])
	assert.NoDirExists(t, path, "the folder went")
	assert.Contains(t, gitOut(t, repo, "branch", "--list", "task-412"), "task-412", "the branch is kept")
}

func TestStopWithoutTheFlagLeavesTheWorktree(t *testing.T) {
	r := newOrchRig(t)
	r.grantedStop()
	_, path := r.taskWorktree("Dev2", 5)
	code, out := r.stopWith("Dev2", false)
	require.Equal(t, 200, code, "%v", out)
	assert.Nil(t, out["worktree"])
	assert.DirExists(t, path)
}

func TestStopKeepsAWorktreeWithUncommittedChangesAndSaysWhy(t *testing.T) {
	r := newOrchRig(t)
	r.grantedStop()
	_, path := r.taskWorktree("Dev2", 398)
	for _, f := range []string{"a.txt", "b.txt", "c.txt"} {
		require.NoError(t, os.WriteFile(filepath.Join(path, f), []byte("x"), 0o600))
	}
	code, out := r.stopWith("Dev2", true)
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, true, out["archived"], "the worker is archived either way")
	w := wtOf(out)
	assert.Equal(t, "kept", w["state"])
	assert.Equal(t, "3 files are not committed. Nothing was removed.", w["reason"])
	assert.DirExists(t, path)
	assert.FileExists(t, filepath.Join(path, "a.txt"), "nothing was removed")
	rows, err := r.h.bs.ListActivity(context.Background(), board.ActivityFilter{Limit: 50})
	require.NoError(t, err)
	n := 0
	for _, row := range rows {
		if row.Action == "worktree_kept" {
			n++
			assert.Equal(t, "3 files are not committed. Nothing was removed.", row.Note)
			assert.True(t, strings.HasPrefix(row.Actor, "agent:"), row.Actor)
		}
	}
	assert.Equal(t, 1, n, "one Activity row for the refusal")
}

func TestStopOfAWorkerWithNoWorktreeOfItsOwnRemovesNothing(t *testing.T) {
	r := newOrchRig(t)
	r.grantedStop()
	code, out := r.stopWith("Dev2", true)
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "none", wtOf(out)["state"])
}

func TestAWorktreeOutsideItsRepositorysFolderIsNeverRemoved(t *testing.T) {
	r := newOrchRig(t)
	r.grantedStop()
	repo := realOf(t, worktreeRepo(t))
	elsewhere := filepath.Join(t.TempDir(), "task-9") // a folder that is not <repo>-worktrees/task-9
	require.NoError(t, os.MkdirAll(elsewhere, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(elsewhere, "keep.txt"), []byte("x"), 0o600))
	require.NoError(t, r.ss.SetTaskWorktree(context.Background(), store.TaskWorktree{SessionID: r.sid["Dev2"], TaskID: 9, Name: "task-9", Path: elsewhere, Repo: repo}))
	code, out := r.stopWith("Dev2", true)
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "kept", wtOf(out)["state"])
	assert.FileExists(t, filepath.Join(elsewhere, "keep.txt"))
}

// A launch with worktree_task starts the worker in <repo>-worktrees/task-N on branch task-N, remembers it as the worker's own, and the list says so (the header chip).
func TestLaunchWithWorktreeTaskStartsTheWorkerInItsOwnWorktree(t *testing.T) {
	server, h, _, ss := setupSessionsTestServerWithConfig(t, config.Load(t.TempDir()))
	repo := realOf(t, worktreeRepo(t))
	require.NoError(t, ss.SetSetting(context.Background(), "launch_in_worktree", "true"))
	post := func(body map[string]any) (int, map[string]any) {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/launch", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", server.URL) // the dashboard's own page: the relaxed folder bounds
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	code, out := post(map[string]any{"working_dir": repo, "agent_type": "claude", "worktree_task": 412, "new_worktree": map[string]any{"name": "x"}})
	assert.Equal(t, 400, code, "not together with new_worktree: %v", out)
	code, out = post(map[string]any{"working_dir": repo, "agent_type": "claude", "worktree_task": -3})
	assert.Equal(t, 400, code, "%v", out)

	code, out = post(map[string]any{"working_dir": repo, "agent_type": "claude", "worktree_task": 412})
	require.Equal(t, 200, code, "%v", out)
	path := filepath.Join(defaultWorktreeDir(repo), "task-412")
	assert.DirExists(t, path)
	assert.Equal(t, "task-412", strings.TrimSpace(gitOut(t, path, "rev-parse", "--abbrev-ref", "HEAD")))
	assert.Equal(t, "task-412", out["worktree"].(map[string]any)["name"])
	sid, _ := out["session_id"].(string)
	require.NotEmpty(t, sid)
	tw, err := ss.GetTaskWorktree(context.Background(), sid)
	require.NoError(t, err)
	require.NotNil(t, tw)
	assert.Equal(t, path, tw.Path)
	names, err := ss.TaskWorktreeNames(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "task-412", names[sid], "the list's rows carry it")

	code, out = post(map[string]any{"working_dir": repo, "agent_type": "claude", "worktree_task": 412}) // the same task again: the folder is taken, nothing is reused
	assert.Equal(t, 400, code, "%v", out)

	// The person's Archive with the tick box: the clean worktree goes, the branch stays.
	b, _ := json.Marshal(map[string]any{"remove_worktree": true})
	rt := chi.NewRouter()
	rt.Post("/api/sessions/live/{sessionID}/archive", h.ArchiveSession)
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, asPerson(httptest.NewRequest("POST", "/api/sessions/live/"+sid+"/archive", bytes.NewReader(b))))
	var arch map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &arch), "status %d: %s", rec.Code, rec.Body.String())
	assert.Equal(t, true, arch["archived"], "%v", arch)
	assert.Equal(t, "removed", wtOf(arch)["state"], "%v", arch)
	assert.NoDirExists(t, path)
	assert.Contains(t, gitOut(t, repo, "branch", "--list", "task-412"), "task-412")
}
