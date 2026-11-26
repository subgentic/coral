package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

func TestWorkersBriefNamesTheListAndTheLaunch(t *testing.T) {
	ws := []board.Worker{
		{Name: "Worker", Purpose: "for code tasks", AgentType: "claude", Model: "claude-sonnet-4-5", Instructions: "Be careful."},
		{Name: "Quick fix", Purpose: "small changes", AgentType: "codex"},
	}
	got := board.WorkersBrief(ws)
	require.Contains(t, got, "Workers approved for this team:")
	require.Contains(t, got, "Worker     for code tasks  (Claude · Sonnet)")
	require.Contains(t, got, "Quick fix  small changes  (Codex)")
	require.Contains(t, got, `coral-board worker launch "Worker" --task N [--worktree]`)
	require.Contains(t, got, "coral-board worker archive NAME --remove-worktree")
	require.Contains(t, got, "a first choice, not a lock")
	require.Equal(t, "", board.WorkersBrief(nil), "no workers: nothing is added to the prompt")
	require.True(t, board.WorkerCached(ws[0]), "Claude with instructions starts from the cache")
	require.False(t, board.WorkerCached(ws[1]))
}

func TestWorkerSetupRules(t *testing.T) {
	for name, w := range map[string]board.Worker{
		"no name":        {AgentType: "claude"},
		"orchestrator":   {Name: "Orchestrator 2", AgentType: "claude"},
		"quote":          {Name: `Wor"ker`, AgentType: "claude"},
		"mention":        {Name: "@Worker", AgentType: "claude"},
		"terminal":       {Name: "Shell", AgentType: "terminal"},
		"no cli":         {Name: "Worker"},
		"long name":      {Name: strings.Repeat("a", 41), AgentType: "claude"},
		"long text":      {Name: "W", AgentType: "claude", Instructions: strings.Repeat("x", board.MaxWorkerInstruct+1)},
		"odd permission": {Name: "W", AgentType: "claude", PermissionMode: "bypassPermissions"},
	} {
		w := w
		require.NotEmpty(t, board.CleanWorker(&w), name)
	}
	ok := board.Worker{Name: "  Quick   fix ", AgentType: "codex", PermissionMode: "custom:abc"}
	require.Empty(t, board.CleanWorker(&ok))
	require.Equal(t, "Quick fix", ok.Name)
}

func TestWorkerLaunchPromptPutsTheInstructionsFirst(t *testing.T) {
	task := workerTaskText(412, "Sign-in lands on a 404", "Look at c0ffee.")
	got := workerLaunchPrompt(&board.Worker{Instructions: "Read only."}, task)
	require.True(t, strings.HasPrefix(got, "Read only.\n\nYour task is #412: Sign-in lands on a 404"), got)
	require.Equal(t, task, workerLaunchPrompt(&board.Worker{}, task), "no instructions: the task text alone")
	require.Equal(t, "Read only.", workerLaunchPrompt(&board.Worker{Instructions: "Read only."}, ""))
}

func TestWorkerTaskTextIsBoundedAndNamesTheTask(t *testing.T) {
	got := workerTaskText(412, "Sign-in lands\non a 404", strings.Repeat("y", 20000))
	require.True(t, strings.HasPrefix(got, "Your task is #412: Sign-in lands"))
	require.Contains(t, got, "coral-board task detail 412")
	require.Less(t, len([]rune(got)), maxWorkerTaskText+100)
}

func workerLaunchFixture(t *testing.T) (*SessionsHandler, string) {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	cfg := &config.Config{LogDir: t.TempDir()}
	cfg.UseCoralDir(t.TempDir())
	return NewSessionsHandler(db, cfg, nil, newMockTerminal(), bs), t.TempDir()
}

func callWorkerLaunch(h *SessionsHandler, ctx context.Context, project, name string, body string, a Actor) *httptest.ResponseRecorder {
	rc := chi.NewRouteContext()
	rc.URLParams.Add("project", project)
	rc.URLParams.Add("name", name)
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
	req = req.WithContext(context.WithValue(ctx, chi.RouteCtxKey, rc))
	rec := httptest.NewRecorder()
	req.Header.Set("Origin", "http://127.0.0.1:8420") // the dashboard's own page: the relaxed folder bounds (strict bounds are for agents outside a project)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Host, req.RemoteAddr = "127.0.0.1:8420", "127.0.0.1:50000"
	h.LaunchWorker(rec, withActor(req, a))
	return rec
}

// The Operator's launch of an approved worker starts an agent on the team with the worker's instructions then the task's text, named after the task, and records where it came from.
func TestLaunchWorkerStartsTheSavedSetupForATask(t *testing.T) {
	h, dir := workerLaunchFixture(t)
	ctx := context.Background()
	_, err := h.bs.SaveWorker(ctx, "crew", "", board.Worker{Name: "Reviewer", AgentType: "claude", Instructions: "Read only.", WorkingDir: dir}, false)
	require.NoError(t, err)
	task, err := h.bs.CreateTask(ctx, "crew", "Review the login fix", "Look at c0ffee.", "high", "Orchestrator")
	require.NoError(t, err)

	rec := callWorkerLaunch(h, ctx, "crew", "reviewer", fmt.Sprintf(`{"task_id":%d}`, task.ID), Actor{Kind: ActorOperator, Name: "Operator"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Equal(t, "Reviewer", out["worker"])
	require.Equal(t, fmt.Sprintf("Reviewer #%d", task.ID), out["display_name"])
	m, err := h.bs.WorkerLaunches(ctx, "crew")
	require.NoError(t, err)
	require.Equal(t, "Reviewer", m[fmt.Sprintf("Reviewer #%d", task.ID)], "the agent says where it came from")

	// a second launch for the same task takes the next free name: names are unique in a team
	rec = callWorkerLaunch(h, ctx, "crew", "Reviewer", fmt.Sprintf(`{"task_id":%d}`, task.ID), Actor{Kind: ActorOperator, Name: "Operator"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), fmt.Sprintf("Reviewer #%d 2", task.ID))
}

func TestLaunchWorkerRefusals(t *testing.T) {
	h, dir := workerLaunchFixture(t)
	ctx := context.Background()
	_, err := h.bs.SaveWorker(ctx, "crew", "", board.Worker{Name: "Worker", AgentType: "claude", WorkingDir: dir}, false)
	require.NoError(t, err)
	op := Actor{Kind: ActorOperator, Name: "Operator"}

	require.Equal(t, http.StatusNotFound, callWorkerLaunch(h, ctx, "crew", "Nobody", `{}`, op).Code, "no such worker")
	require.Equal(t, http.StatusNotFound, callWorkerLaunch(h, ctx, "crew", "Worker", `{"task_id":999}`, op).Code, "no such task")
	require.Equal(t, http.StatusNotFound, callWorkerLaunch(h, ctx, "other", "Worker", `{}`, op).Code, "another team's list is not this team's")
	require.Equal(t, http.StatusBadRequest, callWorkerLaunch(h, ctx, "crew", "Worker", `{"task_id":1,"flags":["--dangerously-skip-permissions"]}`, op).Code, "a caller names the task and nothing else")

	// an agent starts only the workers of its own team: this one is on no team at all
	agentCtx := context.WithValue(ctx, verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "00000000-0000-4000-8000-000000000001", SessionName: "claude-x"})
	rec := callWorkerLaunch(h, agentCtx, "crew", "Worker", `{}`, Actor{Kind: ActorToken, Name: "Orchestrator", Session: "claude-x"})
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Contains(t, rec.Body.String(), "worker_other_team")
}

// The prompt the launch really hands the new agent starts with the worker's instructions, a blank line, then "Your task is #N" (the cacheable part first).
func TestLaunchWorkerGivesTheAgentInstructionsThenTheTask(t *testing.T) {
	h, dir := workerLaunchFixture(t)
	ctx := context.Background()
	_, err := h.bs.SaveWorker(ctx, "crew", "", board.Worker{Name: "Reviewer", AgentType: "claude", Instructions: "Read only.", WorkingDir: dir}, false)
	require.NoError(t, err)
	task, err := h.bs.CreateTask(ctx, "crew", "Review the login fix", "Look at c0ffee.", "high", "Orchestrator")
	require.NoError(t, err)
	rec := callWorkerLaunch(h, ctx, "crew", "Reviewer", fmt.Sprintf(`{"task_id":%d}`, task.ID), Actor{Kind: ActorOperator, Name: "Operator"})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	sid, _ := out["session_id"].(string)
	require.NotEmpty(t, sid)
	var sent string
	require.Eventually(t, func() bool { // the first message is the file the launch command reads
		files, _ := filepath.Glob(filepath.Join(os.TempDir(), "coral_prompt_"+sid+"_*.txt"))
		if len(files) == 0 {
			return false
		}
		raw, err := os.ReadFile(files[0])
		sent = string(raw)
		return err == nil && sent != ""
	}, 5*time.Second, 20*time.Millisecond, "the launch wrote the agent's first message")
	require.Contains(t, sent, "Read only.")
	first, second := strings.Index(sent, "Read only."), strings.Index(sent, fmt.Sprintf("Your task is #%d: Review the login fix", task.ID))
	require.GreaterOrEqual(t, second, 0, "and then the task: %s", sent)
	require.Less(t, first, second, "instructions before the task")
}

// The Operator changing the list posts it to the Orchestrator; a team with none posts nothing.
func TestAWorkerChangePostsTheListToTheOrchestrator(t *testing.T) {
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ctx := context.Background()
	h := NewBoardHandler(bs)

	h.tellOrchestratorWorkersChanged(ctx, "crew")
	msgs, err := bs.ListMessages(ctx, "crew", 100, 0, 0)
	require.NoError(t, err)
	require.Empty(t, msgs, "no Orchestrator on the team: nobody to tell")

	_, err = bs.Subscribe(ctx, "crew", "Orchestrator", "Orchestrator", "", nil, "")
	require.NoError(t, err)
	_, err = bs.SaveWorker(ctx, "crew", "", board.Worker{Name: "Reviewer", Purpose: "reads code", AgentType: "codex"}, false)
	require.NoError(t, err)
	h.tellOrchestratorWorkersChanged(ctx, "crew")
	msgs, err = bs.ListMessages(ctx, "crew", 100, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	require.Contains(t, msgs[0].Content, "@Orchestrator")
	require.Contains(t, msgs[0].Content, "changed the team's approved workers")
	require.Contains(t, msgs[0].Content, `coral-board worker launch "Reviewer" --task N`)

	require.NoError(t, bs.DeleteWorker(ctx, "crew", "Reviewer"))
	h.tellOrchestratorWorkersChanged(ctx, "crew")
	msgs, _ = bs.ListMessages(ctx, "crew", 100, 0, 0)
	require.Len(t, msgs, 2)
	require.Contains(t, msgs[0].Content+msgs[1].Content, "no approved workers now")
}

// #21481: {"worktree": true} starts the worker in its own worktree task-N (the launch route's worktree_task), needs a task, and the archive of that worker with remove_worktree takes the clean folder away and keeps the branch.
func TestLaunchWorkerWithWorktreeUsesTheTaskNumber(t *testing.T) {
	h, _ := workerLaunchFixture(t)
	ctx := context.Background()
	repo := realOf(t, worktreeRepo(t))
	require.NoError(t, h.ss.SetSetting(ctx, "launch_in_worktree", "true"))
	_, err := h.bs.SaveWorker(ctx, "crew", "", board.Worker{Name: "Dev", AgentType: "claude", WorkingDir: repo}, false)
	require.NoError(t, err)
	task, err := h.bs.CreateTask(ctx, "crew", "Fix the login", "details", "high", "Orchestrator")
	require.NoError(t, err)
	op := Actor{Kind: ActorOperator, Name: "Operator"}

	rec := callWorkerLaunch(h, ctx, "crew", "Dev", `{"worktree":true}`, op)
	require.Equal(t, http.StatusBadRequest, rec.Code, "a worktree is named after a task: %s", rec.Body.String())
	require.NoDirExists(t, filepath.Join(defaultWorktreeDir(repo), "task-0"))

	rec = callWorkerLaunch(h, ctx, "crew", "Dev", fmt.Sprintf(`{"task_id":%d,"worktree":true}`, task.ID), op)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	name := fmt.Sprintf("task-%d", task.ID)
	path := filepath.Join(defaultWorktreeDir(repo), name)
	require.DirExists(t, path)
	require.Equal(t, name, out["worktree"].(map[string]any)["name"], "%v", out)
	sid, _ := out["session_id"].(string)
	require.NotEmpty(t, sid)
	tw, err := h.ss.GetTaskWorktree(ctx, sid)
	require.NoError(t, err)
	require.NotNil(t, tw, "the launch remembers the folder as the worker's own")
	require.Equal(t, path, tw.Path)

	// without the flag nothing changes: no worktree, no record
	rec = callWorkerLaunch(h, ctx, "crew", "Dev", fmt.Sprintf(`{"task_id":%d}`, task.ID), op)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NotContains(t, rec.Body.String(), `"worktree"`)
}
