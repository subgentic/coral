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

// Brief task 10 (#21059): Split asks the team's Orchestrator to file follow-up tasks for a change over the limit. Send back is the review's own Request changes with the verdict's note, so it
// needs no route of its own; the verdict carries the note and the team's mode.
func TestReviewSizeSplitAsksTheOrchestratorAndSendBackHasItsNote(t *testing.T) {
	_, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "team", "Orchestrator")
	ctx := context.Background()
	h.SetTaskArtifactWriter(t.TempDir(), func(context.Context, *board.Task, string) error { return nil })
	_, err := h.bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-dev", nil, "all")
	require.NoError(t, err)
	task, err := h.bs.CreateTask(ctx, "team", "Big change", "", "medium", "Orchestrator", "Frontend Dev 2")
	require.NoError(t, err)
	var d strings.Builder
	d.WriteString("diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,0 +1,900 @@\n" + strings.Repeat("+x\n", 900))
	require.NoError(t, writeChangesArtifact(h.taskArtifactPath(task.BoardID, task.ID), []byte(d.String())))
	id := strconv.FormatInt(task.ID, 10)
	p := map[string]string{"project": "team", "taskID": id}
	split := func(mod func(*http.Request)) (int, map[string]any) {
		return reviewSizeCall(h, h.SplitReviewSize, http.MethodPost, "/api/board/team/tasks/"+id+"/review-size/split", "", p, mod)
	}
	asked := func() []string {
		msgs, err := h.bs.ListMessages(ctx, "team", 100, 0, 0)
		require.NoError(t, err)
		var out []string
		for _, m := range msgs {
			if strings.Contains(m.Content, "Split #"+id) {
				out = append(out, m.Content)
			}
		}
		return out
	}

	code, _ := split(nil)
	assert.Equal(t, http.StatusConflict, code, "the guard is off: nothing is over the limit")
	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 800, Files: 20, OverLimit: reviewsize.ModeSplit})
	require.NoError(t, err)

	code, _ = split(func(r *http.Request) {
		*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-dev", SessionName: "claude-dev"}))
	})
	assert.Equal(t, http.StatusForbidden, code, "an agent that is not the Orchestrator cannot ask for a split")
	code, _ = split(func(r *http.Request) { r.Header.Set(tunnel.ViaHeader, "1") })
	assert.Equal(t, http.StatusForbidden, code, "never through Coral Hub")
	assert.Equal(t, tunnel.TierNever, tunnel.Classify(http.MethodPost, "/api/board/team/tasks/7/review-size/split", ""))
	assert.Empty(t, asked(), "the refused calls asked nobody")

	code, out := split(nil)
	require.Equal(t, http.StatusOK, code, "%v", out)
	got := asked()
	require.Len(t, got, 1)
	assert.Contains(t, got[0], "@Orchestrator", "the Orchestrator is the one asked")
	assert.Contains(t, got[0], "900 lines in 1 file, limit 800 lines or 20 files")

	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 5000})
	require.NoError(t, err)
	code, _ = split(nil)
	assert.Equal(t, http.StatusConflict, code, "a change under the limit is not split")

	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 800, OverLimit: reviewsize.ModeSendBack})
	require.NoError(t, err)
	_, v := reviewSizeCall(h, h.TaskReviewSize, http.MethodGet, "/api/board/team/tasks/"+id+"/review-size", "", p, nil)
	assert.Equal(t, "send_back", v["over_limit"])
	assert.Contains(t, v["send_back_note"], "900 lines in 1 file")
	assert.Contains(t, v["send_back_note"], "800 lines")
	assert.Nil(t, v["split_ask"], "only the Split mode carries its ask")
	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 800, OverLimit: reviewsize.ModeSplit})
	require.NoError(t, err)
	_, v = reviewSizeCall(h, h.TaskReviewSize, http.MethodGet, "/api/board/team/tasks/"+id+"/review-size", "", p, nil)
	assert.Equal(t, "Split #"+id+" (900 lines in 1 file, limit 800 lines) into follow-up tasks under the limit.", v["split_ask"])
}

// Send back on the banner (#21059): a task waiting in review whose change is over the limit goes back to its author with the note, and the author is told; a change under the limit, an agent that is
// not the Orchestrator and Coral Hub cannot use it.
func TestReviewSizeSendBackReturnsTheTaskToItsAuthor(t *testing.T) {
	_, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "team", "Orchestrator")
	ctx := context.Background()
	h.SetTaskArtifactWriter(t.TempDir(), func(context.Context, *board.Task, string) error { return nil })
	for _, s := range []struct{ id, title, session string }{{"Frontend Dev 2", "Frontend", "claude-fe"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, s.session, nil, "all")
		require.NoError(t, err)
	}
	task, err := h.bs.CreateTask(ctx, "team", "Big change", "", "medium", "Orchestrator", "Frontend Dev 2")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "team", "Frontend Dev 2", task.ID)
	require.NoError(t, err)
	_, err = h.bs.SubmitCompletionReview(ctx, "team", task.ID, "Frontend Dev 2", "built", "success", "needs review", []board.TaskArtifact{{Name: "fix", Kind: board.PatchKind, URI: "coral://artifacts/d1", Digest: "d1", Revision: "base1"}})
	require.NoError(t, err)
	_, _, err = h.bs.HandToOrchestrator(ctx, "team", task.ID, "Frontend Dev 2")
	require.NoError(t, err)
	var d strings.Builder
	d.WriteString("diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1,0 +1,900 @@\n" + strings.Repeat("+x\n", 900))
	require.NoError(t, writeChangesArtifact(h.taskArtifactPath(task.BoardID, task.ID), []byte(d.String())))
	id := strconv.FormatInt(task.ID, 10)
	p := map[string]string{"project": "team", "taskID": id}
	back := func(body string, mod func(*http.Request)) (int, map[string]any) {
		return reviewSizeCall(h, h.SendBackReviewSize, http.MethodPost, "/api/board/team/tasks/"+id+"/review-size/send-back", body, p, mod)
	}
	status := func() string {
		tk, err := h.bs.GetTask(ctx, "team", task.ID)
		require.NoError(t, err)
		return tk.Status
	}

	code, _ := back(`{"note":"split it"}`, nil)
	assert.Equal(t, http.StatusConflict, code, "the guard is off: nothing is over the limit")
	_, err = h.bs.SetReviewSizeSetting(ctx, "team", reviewsize.Setting{On: true, Lines: 800, OverLimit: reviewsize.ModeSendBack})
	require.NoError(t, err)

	code, _ = back(`{"note":"split it"}`, func(r *http.Request) {
		*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-fe", SessionName: "claude-fe"}))
	})
	assert.Equal(t, http.StatusForbidden, code, "the author cannot send its own task back through the banner")
	code, _ = back(`{"note":"split it"}`, func(r *http.Request) { r.Header.Set(tunnel.ViaHeader, "1") })
	assert.Equal(t, http.StatusForbidden, code, "never through Coral Hub")
	assert.Equal(t, tunnel.TierNever, tunnel.Classify(http.MethodPost, "/api/board/team/tasks/7/review-size/send-back", ""))
	code, _ = back(`{"note":"split it","extra":1}`, nil)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "review_pending", status(), "the refused calls changed nothing")

	code, out := back(`{"note":"This change is over the team's limit: please split it."}`, nil)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "pending", status(), "back with its author")
	msgs, err := h.bs.ListMessages(ctx, "team", 100, 0, 0)
	require.NoError(t, err)
	told := false
	for _, m := range msgs {
		if strings.Contains(m.Content, "@Frontend Dev 2 [Task #"+id+" sent back by") && strings.Contains(m.Content, "please split it") {
			told = true
		}
	}
	assert.True(t, told, "the author is told on the board, with the note")

	code, _ = back(`{"note":"again"}`, nil)
	assert.NotEqual(t, http.StatusOK, code, "a task already back with its author is not sent back twice")
}
