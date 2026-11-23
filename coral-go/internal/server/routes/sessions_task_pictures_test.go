package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// #20800, pictures on a personal task: images {"body": [hex]} on the create and the edit of a task on an agent's own list, the Operator's alone, uploaded with POST /api/field-images?scope=instruction;
// present replaces, [] clears, omitted leaves; the list shows them; a deleted task takes them away.
func TestAPersonalTaskCarriesPicturesLikeABoardTask(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	_, bh := setupBoardTestServer(t)
	bh.SetTaskArtifactWriter(t.TempDir(), nil)
	h.SetBoardHandler(bh)
	const name, sid = "claude-pic-tasks", "sess-ptask-1"
	terminal.addSession(name, "/tmp/test")
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: t.TempDir(), CreatedAt: time.Now().UTC().Format(time.RFC3339)}))

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.Header.Get("X-Test-Caller") != "agent" {
				req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
				req = asCaller(callerDashCookie)(req)
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Post("/api/field-images", bh.UploadPersonFieldImage)
	r.Get("/api/sessions/live/{name}/tasks", h.ListTasks)
	r.Post("/api/sessions/live/{name}/tasks", h.CreateTask)
	r.Patch("/api/sessions/live/{name}/tasks/{taskID}", h.UpdateTask)
	r.Delete("/api/sessions/live/{name}/tasks/{taskID}", h.DeleteTask)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	base := srv.URL + "/api/sessions/live/" + name + "/tasks"

	upload := func(draft string, shade uint8) string {
		req, err := http.NewRequest("POST", srv.URL+"/api/field-images?scope=instruction&draft="+draft, bytes.NewReader(shadePNG(t, shade)))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "image/png")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		require.Equal(t, http.StatusCreated, resp.StatusCode, "%v", out)
		return out["hex"].(string)
	}
	a, b := upload("pt1", 160), upload("pt1", 161)

	// Create with a picture on the body; an agent cannot name pictures; a field that is not the body, or a picture not uploaded for this, is refused.
	code, out := sendJSONHeader(t, "POST", base, map[string]any{"title": "no", "session_id": sid, "images": map[string]any{"body": []string{a}}}, map[string]string{"X-Test-Caller": "agent"})
	assert.GreaterOrEqual(t, code, 400, "%v", out)
	code, out = sendJSON(t, "POST", base, map[string]any{"title": "no", "session_id": sid, "images_draft": "pt1", "images": map[string]any{"title": []string{a}}})
	assert.Equal(t, "picture_field_unknown", out["code"], "%d", code)
	code, out = sendJSON(t, "POST", base, map[string]any{"title": "no", "session_id": sid, "images_draft": "elsewhere", "images": map[string]any{"body": []string{strings.Repeat("e", 64)}}})
	assert.Equal(t, "picture_not_yours", out["code"], "%d", code)

	code, out = sendJSON(t, "POST", base, map[string]any{"title": "Match the mock", "body": "see the picture", "session_id": sid, "images_draft": "pt1", "images": map[string]any{"body": []string{a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{a}, imagesOf(out, "body"))
	id := int64(out["id"].(float64))
	edit := base + "/" + fmt.Sprint(id) + "?session_id=" + sid

	// The list shows them; an edit with images replaces, without leaves, [] clears.
	list := func() []string {
		resp, err := http.Get(base + "?session_id=" + sid)
		require.NoError(t, err)
		defer resp.Body.Close()
		var tasks []map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&tasks))
		require.Len(t, tasks, 1)
		return imagesOf(tasks[0], "body")
	}
	assert.Equal(t, []string{a}, list())
	code, out = sendJSON(t, "PATCH", edit, map[string]any{"title": "Match the mock!", "images_draft": "pt1", "images": map[string]any{"body": []string{b, a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{b, a}, imagesOf(out, "body"))
	code, out = sendJSON(t, "PATCH", edit, map[string]any{"title": "Match the mock"}) // omitted: left
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, []string{b, a}, list())

	// A failed save is said plainly; the edit itself stands.
	bh.setFieldImages = func(context.Context, string, string, string, map[string][]board.GoalImage) error {
		return fmt.Errorf("disk full")
	}
	code, out = sendJSON(t, "PATCH", edit, map[string]any{"images_draft": "pt1", "images": map[string]any{"body": []string{a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["pictures_not_saved"])
	bh.setFieldImages = nil
	code, out = sendJSON(t, "PATCH", edit, map[string]any{"images": map[string]any{"body": []string{}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Empty(t, list())

	// Pictures again, then the task is deleted: they go with it.
	code, out = sendJSON(t, "PATCH", edit, map[string]any{"images_draft": "pt1", "images": map[string]any{"body": []string{a}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	req, _ := http.NewRequest("DELETE", edit, nil)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	left, _ := bh.bs.FieldImages(context.Background(), store.AgentTaskProject(name, &[]string{sid}[0]), board.FieldImagesTask, board.TaskFieldImagesOwner(id))
	assert.Empty(t, left, "a deleted task's pictures are removed")
}
