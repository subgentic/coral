package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	_ "modernc.org/sqlite"
)

// Files an agent uploads for a task show on the task, whatever its state (#12755): `task show` lists what the upload record links to it, and an upload for a finished task is refused in words, never linked and lost.

func (l *linkRig) showTask(t *testing.T, board string, id int64) map[string]any {
	t.Helper()
	bh := NewBoardHandler(l.h.bs)
	bh.SetTaskArtifactWriter(l.coralDir, nil)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/tasks/{taskID}", bh.GetTask)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/board/"+board+"/tasks/"+strconv.FormatInt(id, 10), nil))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

func taskArtifactNames(task map[string]any) []string {
	wf, _ := task["workflow"].(map[string]any)
	var names []string
	list, _ := wf["artifacts"].([]any)
	for _, a := range list {
		names = append(names, a.(map[string]any)["name"].(string))
	}
	return names
}

func (l *linkRig) setStatus(t *testing.T, id int64, status string) {
	t.Helper()
	db, err := sqlx.Open("sqlite", l.boardDB)
	require.NoError(t, err)
	defer db.Close()
	_, err = db.ExecContext(context.Background(), `UPDATE board_tasks SET status = ? WHERE id = ?`, status, id)
	require.NoError(t, err)
}

func TestAFileUploadedWhileTheTaskIsInReviewShowsOnTheTask(t *testing.T) {
	l := newLinkRig(t)
	id := l.task("alpha", "Backend", true)
	l.setStatus(t, id, "review_pending")

	code, out := l.post("s1", "# details\nthe viewer's details open\n", map[string]string{taskHeader: strconv.FormatInt(id, 10)})
	require.Equal(t, http.StatusCreated, code, out)

	assert.Equal(t, []string{"report.md"}, taskArtifactNames(l.showTask(t, "alpha", id)), "task show lists the upload the record links to the task")

	// and in every other open state
	for _, st := range []string{"in_progress", "pending", "blocked"} {
		l.setStatus(t, id, st)
		assert.Equal(t, []string{"report.md"}, taskArtifactNames(l.showTask(t, "alpha", id)), st)
	}
	// a task another member has shows none of it
	other := l.task("alpha", "Frontend", true)
	assert.Empty(t, taskArtifactNames(l.showTask(t, "alpha", other)))
}

func TestAnUploadForAFinishedTaskIsRefusedInWordsNotLinkedAndLost(t *testing.T) {
	l := newLinkRig(t)
	for _, st := range []string{"completed", "skipped"} {
		id := l.task("alpha", "Backend", true)
		l.setStatus(t, id, st)
		code, out := l.post("s1", "late "+st, map[string]string{taskHeader: strconv.FormatInt(id, 10)})
		assert.GreaterOrEqual(t, code, 400, st)
		msg, _ := out["error"].(string)
		assert.Contains(t, msg, "is "+st, st+": the reason is said")
		assert.Contains(t, msg, "--no-task", st+": and what to do")
		assert.Empty(t, taskArtifactNames(l.showTask(t, "alpha", id)), st+": nothing was linked")
	}
	// still allowed for an open one, and for none
	id := l.task("alpha", "Backend", true)
	code, _ := l.post("s1", "fine", map[string]string{taskHeader: strconv.FormatInt(id, 10)})
	assert.Equal(t, http.StatusCreated, code)
	code, _ = l.post("s1", "unlinked", map[string]string{taskHeader: "none"})
	assert.Equal(t, http.StatusCreated, code)
}

// A file the task's own result names AND the record links to it is listed once.
func TestAFileBothLinkedAndNamedByTheResultIsListedOnce(t *testing.T) {
	l := newLinkRig(t)
	id := l.task("alpha", "Backend", true)
	code, out := l.post("s1", "# the plan\n", map[string]string{taskHeader: strconv.FormatInt(id, 10)})
	require.Equal(t, http.StatusCreated, code, out)
	uri, _ := out["uri"].(string)
	require.NotEmpty(t, uri)
	_, err := l.h.bs.CompleteTaskWithArtifacts(context.Background(), "alpha", id, "Backend", nil, "success", []board.TaskArtifact{{Name: "report.md", URI: uri}})
	require.NoError(t, err)

	assert.Equal(t, []string{"report.md"}, taskArtifactNames(l.showTask(t, "alpha", id)), "once, not once as the result's and once as the upload")
}

// The Orchestrator's decision on #12755: an upload with no --task links to the uploader's one OPEN task, in progress or in review; with more than one open it links to none and says so.
func TestAnUploadWithNoTaskLinksToTheOneOpenTaskInProgressOrInReview(t *testing.T) {
	l := newLinkRig(t)
	id := l.task("alpha", "Backend", true)

	code, out := l.post("s1", "evidence one", nil)
	require.Equal(t, http.StatusCreated, code, out)
	assert.EqualValues(t, id, out["task_id"], "in progress: linked, as before")

	l.setStatus(t, id, "review_pending") // submitted: the agent adds more evidence
	code, out = l.post("s1", "evidence two", nil)
	require.Equal(t, http.StatusCreated, code, out)
	assert.EqualValues(t, id, out["task_id"], "in review: linked too")
	assert.NotContains(t, out, "task_note")
	assert.Len(t, taskArtifactNames(l.showTask(t, "alpha", id)), 2, "and both are on the task")

	l.setStatus(t, id, "completed") // nothing is open: linked to none
	code, out = l.post("s1", "evidence three", nil)
	require.Equal(t, http.StatusCreated, code, out)
	assert.NotContains(t, out, "task_id")
	assert.NotContains(t, out, "task_note", "no open task is not a reason to say anything")
}

func TestTwoOpenTasksLinkAnUnnamedUploadToNoneAndSayWhy(t *testing.T) {
	l := newLinkRig(t)
	a := l.task("alpha", "Backend", true)
	b := l.task("alpha", "Backend", false)
	l.setStatus(t, b, "review_pending") // one in progress, one in review: two open

	code, out := l.post("s1", "which one?", nil)
	require.Equal(t, http.StatusCreated, code, out)
	assert.NotContains(t, out, "task_id", "linked to none")
	assert.Contains(t, out["task_note"], "more than one open task")
	assert.Contains(t, out["task_note"], "--task N", "and what to do")

	code, out = l.post("s1", "named", map[string]string{taskHeader: strconv.FormatInt(b, 10)})
	require.Equal(t, http.StatusCreated, code, out)
	assert.EqualValues(t, b, out["task_id"], "naming one links it")
	_ = a
}
