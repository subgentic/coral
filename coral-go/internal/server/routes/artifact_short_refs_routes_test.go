package routes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9841 through the routes: every board text that carries a link is expanded or refused by the server, so any client is covered. A refusal stores nothing.
func TestShortArtifactRefsInBoardPostsAndTaskText(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	id := hexID("b801aafb", "f5f")
	h.coralDir = t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(h.coralDir, "artifacts", "objects"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(h.coralDir, "artifacts", "objects", id), []byte("x"), 0o644))
	full := "coral://artifacts/" + id
	short := "coral://artifacts/b801aafb…f5f"
	for _, who := range []struct{ id, role string }{{"Dev", "Backend Dev"}, {"Lead", "Orchestrator"}} { // only an orchestrator makes a task
		_, err := h.bs.Subscribe(ctx, "p", who.id, who.role, who.id+"-session", nil, "all")
		require.NoError(t, err)
	}
	url := func(path string) string { return server.URL + "/api/board/p" + path }
	post := func(path string, payload map[string]any) (int, map[string]any) {
		return postCode(t, url(path), payload)
	}

	// a post
	code, out := post("/messages", map[string]any{"subscriber_id": "Dev", "content": "report " + short + " is ready"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "report "+full+" is ready", out["content"], "the stored post has the full link")

	// a post with no such artifact, and one that is only checked: refused, with the way to fix it, nothing stored
	for _, dry := range []bool{false, true} {
		code, out = post("/messages", map[string]any{"subscriber_id": "Dev", "content": "see coral://artifacts/0123abcd…fff", "dry_run": dry})
		assert.Equal(t, http.StatusBadRequest, code, "dry_run=%v", dry)
		assert.Equal(t, "artifact_ref_unknown", out["code"])
		assert.Equal(t, true, out["not_sent"])
		assert.Contains(t, out["message"], "full 64-character link")
	}
	msgs, err := h.bs.ListMessages(ctx, "p", 100, 0, 0)
	require.NoError(t, err)
	for _, m := range msgs {
		assert.NotContains(t, m.Content, "0123abcd", "a refused post is not stored")
	}

	// a task: title and body
	code, out = post("/tasks", map[string]any{"title": "Review " + short, "body": "the report is " + short, "created_by": "Lead", "subscriber_id": "Lead", "assigned_to": "Dev"})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	taskID := int64(out["id"].(float64))
	task, err := h.bs.GetTask(ctx, "p", taskID)
	require.NoError(t, err)
	assert.Equal(t, "Review "+full, task.Title)
	require.NotNil(t, task.Body)
	assert.Equal(t, "the report is "+full, *task.Body)
	code, out = post("/tasks", map[string]any{"title": "x coral://artifacts/0123abcd", "created_by": "Lead", "subscriber_id": "Lead"})
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "artifact_ref_unknown", out["code"])

	// a completion message
	_, err = h.bs.ClaimTask(ctx, "p", "Dev", taskID)
	require.NoError(t, err)
	code, out = post("/tasks/"+itoa(taskID)+"/complete", map[string]any{"subscriber_id": "Dev", "message": "done, " + short})
	require.Equal(t, http.StatusOK, code, "%v", out)
	done, err := h.bs.GetTask(ctx, "p", taskID)
	require.NoError(t, err)
	require.NotNil(t, done.CompletionMessage)
	assert.Equal(t, "done, "+full, *done.CompletionMessage)
}
