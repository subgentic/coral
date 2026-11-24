package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/reviewsize"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

func reviewSizeCall(h *BoardHandler, fn http.HandlerFunc, method, path, body string, params map[string]string, mod func(*http.Request)) (int, map[string]any) {
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	if mod != nil {
		mod(req)
	}
	rec := httptest.NewRecorder()
	fn(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestReviewSizeSettingRoutes(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, s := range []struct{ id, title, session string }{{"Orchestrator", "Orchestrator", "claude-orch"}, {"Dev", "Developer", "claude-dev"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, s.session, nil, "all")
		require.NoError(t, err)
	}
	as := func(session string) func(*http.Request) {
		return func(r *http.Request) {
			*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-" + session, SessionName: session}))
		}
	}
	p := map[string]string{"project": "team"}
	get := func(mod func(*http.Request)) (int, map[string]any) {
		return reviewSizeCall(h, h.GetReviewSizeSetting, http.MethodGet, "/api/board/team/review-size", "", p, mod)
	}
	put := func(body string, mod func(*http.Request)) (int, map[string]any) {
		return reviewSizeCall(h, h.PutReviewSizeSetting, http.MethodPut, "/api/board/team/review-size", body, p, mod)
	}

	code, out := get(nil)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["on"], "off by default")

	code, _ = get(as("claude-dev"))
	assert.Equal(t, http.StatusForbidden, code, "an agent reads nothing")
	code, _ = put(`{"on":true,"lines":5}`, as("claude-dev"))
	assert.Equal(t, http.StatusForbidden, code, "an agent changes nothing")
	code, _ = put(`{"on":true,"lines":5}`, func(r *http.Request) { r.Header.Set(tunnel.ViaHeader, "1") })
	assert.Equal(t, http.StatusForbidden, code, "never through Coral Hub")
	assert.Equal(t, tunnel.TierNever, tunnel.Classify(http.MethodPut, "/api/board/team/review-size", ""))
	assert.Equal(t, tunnel.TierNever, tunnel.Classify(http.MethodGet, "/api/board/team/review-size", ""))
	assert.Equal(t, tunnel.TierNever, tunnel.Classify(http.MethodGet, "/api/board/team/tasks/7/review-size", ""))
	set, err := h.bs.GetReviewSizeSetting(ctx, "team")
	require.NoError(t, err)
	assert.False(t, set.On, "refused calls saved nothing")

	code, out = put(`{"on":true,"lines":800,"files":20,"skip":["*.lock","docs/**"],"only_roles":["Developer"]}`, as("claude-orch"))
	require.Equal(t, http.StatusOK, code, "%v", out)
	set, _ = h.bs.GetReviewSizeSetting(ctx, "team")
	assert.True(t, set.On)
	assert.Equal(t, 800, set.Lines)
	assert.Equal(t, []string{"*.lock", "docs/**"}, set.Skip)

	for _, bad := range []string{`{"on":true}`, `{"on":true,"lines":-4}`, `{"on":true,"lines":5,"skip":["a\nb"]}`, `not json`, `{"on":true,"lines":5,"unknown":1}`} {
		code, _ = put(bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	set, _ = h.bs.GetReviewSizeSetting(ctx, "team")
	assert.Equal(t, 800, set.Lines, "a refused save changed nothing")
}

// The banner's source: a task's own changes.diff counted by the team's guard, with the skipped paths left out; a change at or under the limits, a team with the guard off and a role the guard does not cover all give no warning.
func TestTaskReviewSizeVerdict(t *testing.T) {
	_, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "team", "Orchestrator")
	ctx := context.Background()
	coralDir := t.TempDir()
	h.SetTaskArtifactWriter(coralDir, func(context.Context, *board.Task, string) error { return nil })
	task, err := h.bs.CreateTask(ctx, "team", "Big change", "", "medium", "Orchestrator", "Frontend Dev 2")
	require.NoError(t, err)

	var d strings.Builder
	d.WriteString("diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,0 +1,900 @@\n")
	d.WriteString(strings.Repeat("+x\n", 900))
	d.WriteString("diff --git a/go.lock b/go.lock\n--- a/go.lock\n+++ b/go.lock\n@@ -1,0 +1,212 @@\n")
	d.WriteString(strings.Repeat("+y\n", 212))
	require.NoError(t, writeChangesArtifact(h.taskArtifactPath(task.BoardID, task.ID), []byte(d.String())))

	id := strconv.FormatInt(task.ID, 10)
	verdict := func(mod func(*http.Request)) (int, map[string]any) {
		return reviewSizeCall(h, h.TaskReviewSize, http.MethodGet, "/api/board/team/tasks/"+id+"/review-size", "", map[string]string{"project": "team", "taskID": id}, mod)
	}
	code, out := verdict(nil)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["applies"], "off by default: no warning")

	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 800, Files: 20, Skip: []string{"*.lock"}})
	require.NoError(t, err)
	code, out = verdict(nil)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, true, out["applies"])
	assert.Equal(t, true, out["over"])
	assert.EqualValues(t, 900, out["lines"])
	assert.EqualValues(t, 1, out["files"])
	assert.EqualValues(t, 212, out["skipped_lines"])
	assert.EqualValues(t, 1, out["skipped_files"])
	assert.EqualValues(t, 800, out["limit_lines"])
	assert.EqualValues(t, 20, out["limit_files"])

	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 900, Skip: []string{"*.lock"}})
	require.NoError(t, err)
	_, out = verdict(nil)
	assert.Equal(t, false, out["over"], "at the limit is not over")

	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 10, OnlyRoles: []string{"QA Engineer"}})
	require.NoError(t, err)
	_, out = verdict(nil)
	assert.Equal(t, false, out["applies"], "a role the guard does not cover is not judged")

	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 10, OnlyRoles: []string{"QA Engineer"}, Roles: map[string]reviewsize.RoleLimits{}})
	require.NoError(t, err)
	code, _ = verdict(func(r *http.Request) { r.Header.Set(tunnel.ViaHeader, "1") })
	assert.Equal(t, http.StatusForbidden, code, "never through Coral Hub")

	// No diff kept for the task: a 404, as its changes.diff is, and no verdict is made up.
	require.NoError(t, os.Remove(h.taskArtifactPath(task.BoardID, task.ID)))
	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 10})
	require.NoError(t, err)
	code, _ = verdict(nil)
	assert.Equal(t, http.StatusNotFound, code)
}
