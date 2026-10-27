package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"testing"
)

func TestVersionedTaskTextAuthorityAndHistory(t *testing.T) {
	server, h := setupBoardTestServer(t)
	defer server.Close()
	ctx := context.Background()
	task, err := h.bs.CreateTask(ctx, "team", "Before", "body", "medium", "creator", "worker")
	require.NoError(t, err)
	registerTaskPlanner(t, h, "team", "Boss")
	verified := withActor(httptest.NewRequest("PATCH", "/", nil), Actor{Kind: ActorOperator, Name: "Operator"})
	require.True(t, h.requireTaskTextEditor(httptest.NewRecorder(), verified, "team", task, "operator"), "verified Operator authority is independent of claim spelling")
	mux := chi.NewRouter()
	mux.Patch("/api/board/{project}/tasks/{taskID}", h.UpdateTask)
	mux.Get("/api/board/{project}/tasks/{taskID}", h.GetTask)
	mux.Get("/api/board/{project}/tasks/{taskID}/history", h.TaskHistory)
	call := func(method, path string, body any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(b))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	path := fmt.Sprintf("/api/board/team/tasks/%d", task.ID)
	require.Equal(t, 403, call("PATCH", path, map[string]any{"subscriber_id": "worker", "title": "Forbidden"}).Code)
	for i, actor := range []string{"Boss", "Operator"} {
		w := call("PATCH", path, map[string]any{"subscriber_id": actor, "title": fmt.Sprintf("Title %d", i)})
		require.Equal(t, 200, w.Code, w.Body.String())
	}
	require.Equal(t, 200, call("GET", path+"/history", nil).Code)
	w := call("GET", path+"?version=1", nil)
	require.Equal(t, 200, w.Code)
	require.Contains(t, w.Body.String(), `"title":"Before"`)
	require.Equal(t, 404, call("GET", fmt.Sprintf("/api/board/other/tasks/%d/history", task.ID), nil).Code)
	_, err = h.bs.CancelTask(ctx, "team", task.ID, "Operator", nil)
	require.NoError(t, err)
	require.Equal(t, 409, call("PATCH", path, map[string]any{"subscriber_id": "Operator", "title": "Too late"}).Code)
}

func TestTaskTextNoticeKeepsItsVersionWhenAnotherEditWinsTheRace(t *testing.T) {
	server, h := setupBoardTestServer(t)
	defer server.Close()
	ctx := context.Background()
	before, err := h.bs.CreateTask(ctx, "team", "First", "", "medium", "creator", "worker")
	require.NoError(t, err)
	second := "Second"
	v2, err := h.bs.EditTaskText(ctx, "team", before.ID, "creator", &second, nil, 0, 1)
	require.NoError(t, err)
	third := "Third"
	_, err = h.bs.EditTaskText(ctx, "team", before.ID, "Operator", &third, nil, 0, 2)
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "reader", "Reader", "reader-session", nil, "all")
	require.NoError(t, err)
	h.announceTaskTextEdit(ctx, "team", "creator", before, v2)
	messages, err := h.bs.ReadMessages(ctx, "team", "reader", 50, true)
	require.NoError(t, err)
	require.Len(t, messages, 1)
	require.Contains(t, messages[0].Content, "edited to v2 by creator")
	require.Contains(t, messages[0].Content, `title "First" → "Second"`)
	require.NotContains(t, messages[0].Content, "Third")
}

// #8951 round 2: creating a task never grants planning authority over later requirements.
func TestTaskCreatorCannotEditOrRestorePlannerRequirements(t *testing.T) {
	for _, mode := range []string{"restore", "restore-in-review", "title"} {
		t.Run(mode, func(t *testing.T) {
			server, h := setupBoardTestServer(t)
			defer server.Close()
			ctx := context.Background()
			registerTaskPlanner(t, h, "team", "Orchestrator")
			task, err := h.bs.CreateTask(ctx, "team", "Original title", "Original body", "medium", "creator", "worker")
			require.NoError(t, err)
			amended, err := h.bs.AmendTask(ctx, "team", task.ID, "Orchestrator", 1, "Planner requirements", map[string]interface{}{"body": "Planner body", "workflow_instructions": "Planner instructions"})
			require.NoError(t, err)
			if mode == "restore-in-review" {
				_, err = h.bs.ClaimTask(ctx, "team", "worker", task.ID)
				require.NoError(t, err)
				_, err = h.bs.SubmitCompletionReviewAtRevisionAndCandidate(ctx, "team", task.ID, "worker", "done", "success", "please review", nil, &amended.Revision, "")
				require.NoError(t, err)
				_, _, err = h.bs.HandToOrchestrator(ctx, "team", task.ID, "worker")
				require.NoError(t, err)
				_, err = h.bs.Subscribe(ctx, "team", "QA", "QA", "qa-session", nil, "all")
				require.NoError(t, err)
				_, _, err = h.bs.DelegateReview(ctx, "team", task.ID, "Orchestrator", []string{"QA"})
				require.NoError(t, err)
			}
			mux := chi.NewRouter()
			mux.Patch("/api/board/{project}/tasks/{taskID}", h.UpdateTask)
			payload := map[string]interface{}{"subscriber_id": "creator", "restore_version": 1}
			if mode == "title" {
				delete(payload, "restore_version")
				payload["title"] = "Creator changed title"
			}
			raw, _ := json.Marshal(payload)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest("PATCH", fmt.Sprintf("/api/board/team/tasks/%d", task.ID), bytes.NewReader(raw)))
			require.Equal(t, 403, w.Code, w.Body.String())
			current, err := h.bs.GetTask(ctx, "team", task.ID)
			require.NoError(t, err)
			require.Equal(t, "Original title", current.Title)
			require.Equal(t, "Planner body", *current.Body)
			require.Equal(t, amended.Workflow.EffectiveInstructions, current.Workflow.EffectiveInstructions)
			require.Equal(t, amended.Version, current.Version)
			// The same restoration remains available to the registered planner.
			if mode != "title" {
				payload["subscriber_id"] = "Orchestrator"
				raw, _ = json.Marshal(payload)
				w = httptest.NewRecorder()
				mux.ServeHTTP(w, httptest.NewRequest("PATCH", fmt.Sprintf("/api/board/team/tasks/%d", task.ID), bytes.NewReader(raw)))
				require.Equal(t, 200, w.Code, w.Body.String())
				restored, err := h.bs.GetTask(ctx, "team", task.ID)
				require.NoError(t, err)
				require.Equal(t, "Original body", *restored.Body)
				require.Equal(t, amended.Version+1, restored.Version)
			}
		})
	}
}

func TestTaskTextNoticeQuotedMentionsAreNotTargets(t *testing.T) {
	server, h := setupBoardTestServer(t)
	defer server.Close()
	ctx := context.Background()
	before, err := h.bs.CreateTask(ctx, "team", "Before @Innocent", "", "medium", "Operator", "worker")
	require.NoError(t, err)
	title := "After @all"
	after, err := h.bs.EditTaskText(ctx, "team", before.ID, "Operator", &title, nil, 0, 1)
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "reader", "Reader", "reader-session", nil, "all")
	require.NoError(t, err)
	h.announceTaskTextEdit(ctx, "team", "Operator", before, after)
	h.announceTaskEdit(ctx, "team", false, before, after, before.Status)
	messages, err := h.bs.ReadMessages(ctx, "team", "reader", 50, true)
	require.NoError(t, err)
	require.Len(t, messages, 2)
	require.NotContains(t, messages[1].Content, "@all", "legacy edit notices neutralize quoted task titles too")
	require.Contains(t, messages[0].Content, "@worker", "the intended assignee mention stays")
	require.NotContains(t, messages[0].Content, "@Innocent")
	require.NotContains(t, messages[0].Content, "@all")
	require.Contains(t, messages[0].Content, "(at)Innocent")
	require.Contains(t, messages[0].Content, "(at)all")
}
