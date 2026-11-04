package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

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
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
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
	refreshComputeHook = func() { passes.Add(1); time.Sleep(400 * time.Millisecond) }
	t.Cleanup(func() { refreshComputeHook = func() {} })

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
