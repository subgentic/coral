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

// #20818: a create whose title matches an open task is answered with that task; the pictures sent with it are not added and the answer says so, so a screen does not show them as attached.
func TestAPersonalTaskCreateThatMatchesAnOpenTaskSaysItsPicturesWereNotAdded(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	_, bh := setupBoardTestServer(t)
	bh.SetTaskArtifactWriter(t.TempDir(), nil)
	h.SetBoardHandler(bh)
	const name, sid = "claude-pic-dupe", "sess-ptask-2"
	terminal.addSession(name, "/tmp/test")
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: t.TempDir(), CreatedAt: time.Now().UTC().Format(time.RFC3339)}))
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
			next.ServeHTTP(w, asCaller(callerDashCookie)(req))
		})
	})
	r.Post("/api/field-images", bh.UploadPersonFieldImage)
	r.Post("/api/sessions/live/{name}/tasks", h.CreateTask)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	base := srv.URL + "/api/sessions/live/" + name + "/tasks"
	req, err := http.NewRequest("POST", srv.URL+"/api/field-images?scope=instruction&draft=dd1", bytes.NewReader(shadePNG(t, 170)))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "image/png")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	var up map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&up))
	resp.Body.Close()
	hex := up["hex"].(string)

	code, first := sendJSON(t, "POST", base, map[string]any{"title": "Same title", "session_id": sid})
	require.Equal(t, http.StatusOK, code, "%v", first)
	assert.Nil(t, first["pictures_not_added"], "a new task has nothing refused")
	code, out := sendJSON(t, "POST", base, map[string]any{"title": "Same title", "session_id": sid, "images_draft": "dd1", "images": map[string]any{"body": []string{hex}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, first["id"], out["id"], "the open task is answered")
	assert.Equal(t, true, out["pictures_not_added"])
	assert.NotEmpty(t, out["pictures_warning"])
	assert.Empty(t, imagesOf(out, "body"), "the task does not show pictures it was not given")
	code, out = sendJSON(t, "POST", base, map[string]any{"title": "Same title", "session_id": sid})
	require.Equal(t, http.StatusOK, code)
	assert.Nil(t, out["pictures_not_added"], "no pictures sent, nothing to say")
	code, out = sendJSON(t, "POST", base, map[string]any{"title": "Same title", "session_id": sid, "images_draft": "dd1", "images": map[string]any{"title": []string{hex}}})
	assert.Equal(t, "picture_field_unknown", out["code"], "a picture that is not allowed is still refused (%d)", code)
}

// #20845: the personal-task PATCH takes body, as the create does: present replaces (and "" clears), omitted leaves, a title edit alone leaves the body, and a finished task is refused as for any edit.
func TestAPersonalTaskPatchTakesABodyLikeCreate(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	const name, sid = "claude-body-tasks", "sess-ptask-body"
	terminal.addSession(name, "/tmp/test")
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: name, WorkingDir: t.TempDir(), CreatedAt: time.Now().UTC().Format(time.RFC3339)}))
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
			next.ServeHTTP(w, asCaller(callerDashCookie)(req))
		})
	})
	r.Get("/api/sessions/live/{name}/tasks", h.ListTasks)
	r.Post("/api/sessions/live/{name}/tasks", h.CreateTask)
	r.Patch("/api/sessions/live/{name}/tasks/{taskID}", h.UpdateTask)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	base := srv.URL + "/api/sessions/live/" + name + "/tasks"

	code, out := sendJSON(t, "POST", base, map[string]any{"title": "write docs", "body": "first words", "session_id": sid})
	require.Equal(t, http.StatusOK, code, "%v", out)
	id := int64(out["id"].(float64))
	edit := fmt.Sprintf("%s/%d?session_id=%s", base, id, sid)
	bodyNow := func() string {
		resp, err := http.Get(base + "?session_id=" + sid)
		require.NoError(t, err)
		defer resp.Body.Close()
		var rows []map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
		for _, x := range rows {
			if int64(x["id"].(float64)) == id {
				s, _ := x["body"].(string)
				return s
			}
		}
		t.Fatalf("task %d not listed", id)
		return ""
	}
	assert.Equal(t, "first words", bodyNow())

	code, out = sendJSON(t, "PATCH", edit, map[string]any{"body": "second words"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "second words", bodyNow(), "the body is replaced")
	code, out = sendJSON(t, "PATCH", edit, map[string]any{"title": "write the docs"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "second words", bodyNow(), "a title edit alone leaves the body")
	code, out = sendJSON(t, "PATCH", edit, map[string]any{"title": "write the docs now", "body": "third words"})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "third words", bodyNow(), "title and body together")
	code, out = sendJSON(t, "PATCH", edit, map[string]any{"body": ""})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "", bodyNow(), "an empty body clears it, as create accepts one")
}
