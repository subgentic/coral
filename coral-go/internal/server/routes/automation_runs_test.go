package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// Recent runs as pages (#13183): GET /api/automations/runs answers at most 50 a request, newest first, with the search and the filters applied before the cut, the true total and a cursor bound to the filters.
// The Operator's list showed the last 100 runs of a job that runs every minute and nothing else; the failing-first case here is a run that is 897th of 900 and is found on page 1 of its search.

type runsFixture struct {
	sh     *ScheduleHandler
	wh     *WorkflowHandler
	router chi.Router
	db     *store.DB
}

func newRunsFixture(t *testing.T) *runsFixture {
	t.Helper()
	cfg := config.Load(t.TempDir())
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	f := &runsFixture{sh: NewScheduleHandler(db, cfg), wh: NewWorkflowHandler(db, cfg), db: db}
	f.router = chi.NewRouter()
	f.router.Get("/api/automations/runs", f.sh.AutomationRuns)
	return f
}

func (f *runsFixture) job(t *testing.T, name string) int64 {
	t.Helper()
	j, err := f.sh.sched.CreateScheduledJob(context.Background(), &store.ScheduledJob{Name: name, CronExpr: "* * * * *", RepoPath: "/tmp", Prompt: "p", Enabled: 1})
	require.NoError(t, err)
	return j.ID
}

func (f *runsFixture) jobRun(t *testing.T, jobID int64, at time.Time, status string) int64 {
	t.Helper()
	id, err := f.sh.sched.CreateScheduledRun(context.Background(), jobID, at.UTC().Format(time.RFC3339), status)
	require.NoError(t, err)
	return id
}

func (f *runsFixture) workflow(t *testing.T, name string) int64 {
	t.Helper()
	w, err := f.wh.ws.CreateWorkflow(context.Background(), &store.Workflow{Name: name, StepsJSON: `[]`, DefaultAgentJSON: "{}", BaseBranch: "main", MaxDurationS: 60, Enabled: 1})
	require.NoError(t, err)
	return w.ID
}

func (f *runsFixture) workflowRun(t *testing.T, wfID int64, at time.Time, trigger string, ctxJSON *string) int64 {
	t.Helper()
	r, err := f.wh.ws.CreateWorkflowRun(context.Background(), wfID, trigger, ctxJSON)
	require.NoError(t, err)
	_, err = f.db.ExecContext(context.Background(), `UPDATE workflow_runs SET created_at = ?, status = 'completed' WHERE id = ?`, at.UTC().Format(time.RFC3339), r.ID)
	require.NoError(t, err)
	return r.ID
}

type runsAnswer struct {
	Runs       []map[string]any `json:"runs"`
	HasMore    bool             `json:"has_more"`
	NextCursor string           `json:"next_cursor"`
	Total      int              `json:"total"`
}

func (f *runsFixture) get(t *testing.T, params url.Values) (int, runsAnswer, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/automations/runs?"+params.Encode(), nil)
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req)
	var a runsAnswer
	_ = json.Unmarshal(rec.Body.Bytes(), &a)
	return rec.Code, a, rec.Body.String()
}

func (f *runsFixture) seed900(t *testing.T) (target int64) {
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	busy := f.job(t, "morning-motivation")
	rare := f.job(t, "rare-report")
	wf := f.workflow(t, "nightly-build")
	n := 0
	for i := 0; i < 900; i++ {
		at := base.Add(-time.Duration(i) * time.Minute) // i = 0 is the newest
		switch {
		case i == 896: // the 897th newest
			target = f.jobRun(t, rare, at, "completed")
		case i%100 == 7:
			f.workflowRun(t, wf, at, "manual", nil)
		default:
			status := "completed"
			if i%10 == 3 {
				status = "failed"
			}
			f.jobRun(t, busy, at, status)
		}
		n++
	}
	require.Equal(t, 900, n)
	return target
}

func TestAutomationRunsPagesEveryRunOnceNewestFirst(t *testing.T) {
	f := newRunsFixture(t)
	f.seed900(t)
	seen := map[string]bool{}
	var lastAt string
	cursor := ""
	pages := 0
	for {
		p := url.Values{"limit": {"500"}} // more than 50 is cut to 50
		if cursor != "" {
			p.Set("cursor", cursor)
		}
		code, a, body := f.get(t, p)
		require.Equal(t, 200, code, body)
		assert.Equal(t, 900, a.Total, "the true total, on every page")
		assert.LessOrEqual(t, len(a.Runs), 50)
		for _, r := range a.Runs {
			key := fmt.Sprintf("%v-%v", r["kind"], r["id"])
			assert.False(t, seen[key], "a run twice: "+key)
			seen[key] = true
			at, _ := r["scheduled_at"].(string)
			if at == "" {
				at, _ = r["created_at"].(string)
			}
			if lastAt != "" {
				assert.LessOrEqual(t, at, lastAt, "newest first")
			}
			lastAt = at
		}
		pages++
		if !a.HasMore {
			assert.Empty(t, a.NextCursor, "the last page has no cursor")
			break
		}
		require.NotEmpty(t, a.NextCursor)
		assert.LessOrEqual(t, len(a.NextCursor), 1024)
		cursor = a.NextCursor
	}
	assert.Equal(t, 900, len(seen), "every run was on exactly one page")
	assert.Equal(t, 18, pages, "900 runs at 50 a page")
}

func TestAutomationRunsSearchIsAppliedBeforeTheCut(t *testing.T) {
	f := newRunsFixture(t)
	target := f.seed900(t)
	// the failing-first case: the 897th of 900 is on page 1 of its own search, and the old reads (the 100 newest) never had it
	code, a, body := f.get(t, url.Values{"q": {"rare-report"}})
	require.Equal(t, 200, code, body)
	require.Len(t, a.Runs, 1, body)
	assert.EqualValues(t, target, a.Runs[0]["id"])
	assert.Equal(t, "job", a.Runs[0]["kind"])
	assert.Equal(t, 1, a.Total)
	assert.False(t, a.HasMore)
	_, up, _ := f.get(t, url.Values{"q": {"  RARE-Rep  "}})
	assert.Equal(t, 1, up.Total, "case does not matter, a part of the name is enough, the ends are trimmed")
	// a word the status says
	_, failed, _ := f.get(t, url.Values{"q": {"failed"}})
	assert.Equal(t, 90, failed.Total, "the runs whose status says failed (every tenth of the busy job's)")
	// a name nobody has
	_, none, _ := f.get(t, url.Values{"q": {"no-such-job"}})
	assert.Equal(t, 0, none.Total)
	assert.Empty(t, none.Runs)
	assert.NotNil(t, none.Runs, "an empty answer is an empty list, never null")
	// a workflow run is found by its workflow's name
	_, wfRuns, _ := f.get(t, url.Values{"q": {"nightly"}})
	assert.Equal(t, 9, wfRuns.Total)
	assert.Equal(t, "workflow", wfRuns.Runs[0]["kind"])
	assert.Equal(t, "nightly-build", wfRuns.Runs[0]["workflow_name"])
}

func TestAutomationRunsFiltersAreAppliedBeforeTheCut(t *testing.T) {
	f := newRunsFixture(t)
	f.seed900(t)
	_, failed, _ := f.get(t, url.Values{"result": {"failed"}})
	assert.Equal(t, 90, failed.Total)
	assert.Len(t, failed.Runs, 50, "the first page of the failed runs, not the failed runs among the newest 50")
	assert.True(t, failed.HasMore)
	for _, r := range failed.Runs {
		assert.Equal(t, "failed", r["status"])
	}
	_, passed, _ := f.get(t, url.Values{"result": {"passed"}})
	assert.Equal(t, 900-90, passed.Total)
	_, running, _ := f.get(t, url.Values{"result": {"running"}})
	assert.Equal(t, 0, running.Total)
	// unread: finished runs nobody opened; opening one takes it out
	_, unread, _ := f.get(t, url.Values{"unread": {"1"}})
	assert.Equal(t, 900, unread.Total)
	first := unread.Runs[0]
	if first["kind"] == "job" {
		_, err := f.sh.sched.MarkScheduledRunSeen(context.Background(), int64(first["id"].(float64)), time.Now().UTC().Format(store.ISOFormat))
		require.NoError(t, err)
	}
	_, unread2, _ := f.get(t, url.Values{"unread": {"1"}})
	assert.Equal(t, 899, unread2.Total, "an opened run is no longer unread")
	// filters together
	_, both, _ := f.get(t, url.Values{"result": {"failed"}, "q": {"morning"}})
	assert.Equal(t, 90, both.Total)
}

func TestAutomationRunsCursorIsBoundToItsFiltersAndRefusesGarbage(t *testing.T) {
	f := newRunsFixture(t)
	f.seed900(t)
	_, page1, _ := f.get(t, url.Values{})
	require.NotEmpty(t, page1.NextCursor)
	for name, p := range map[string]url.Values{
		"a cursor made for no filter, used with a search": {"cursor": {page1.NextCursor}, "q": {"morning"}},
		"a cursor made for no filter, used with a result": {"cursor": {page1.NextCursor}, "result": {"failed"}},
		"a cursor that is not base64url":                  {"cursor": {"not a cursor!"}},
		"a cursor that decodes to something else":         {"cursor": {"e30"}}, // {}
		"a cursor over 1024 bytes":                        {"cursor": {strings.Repeat("A", 1025)}},
		"a result that is not one of the words":           {"result": {"ok"}},
		"an unread that is not 1":                         {"unread": {"yes"}},
		"a search over 200 characters":                    {"q": {strings.Repeat("a", 201)}},
	} {
		code, _, body := f.get(t, p)
		assert.Equal(t, 400, code, name+": "+body)
	}
	// and the cursor is good for what it was made for
	code, page2, body := f.get(t, url.Values{"cursor": {page1.NextCursor}})
	require.Equal(t, 200, code, body)
	assert.Len(t, page2.Runs, 50)
	assert.NotEqual(t, page1.Runs[0]["id"], page2.Runs[0]["id"])
}

func TestAutomationRunsLeaveOutAWorkflowRunAScheduledJobStarted(t *testing.T) {
	f := newRunsFixture(t)
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	job := f.job(t, "j")
	jr := f.jobRun(t, job, at, "completed")
	wf := f.workflow(t, "w")
	ctxJSON := fmt.Sprintf(`{"scheduled_run_id": %d}`, jr)
	f.workflowRun(t, wf, at, "scheduled", &ctxJSON) // the job's run stands for it
	f.workflowRun(t, wf, at.Add(-time.Hour), "manual", nil)
	badCtx := `not json`
	f.workflowRun(t, wf, at.Add(-2*time.Hour), "scheduled", &badCtx) // a scheduled one whose context says no job run: listed
	code, a, body := f.get(t, url.Values{})
	require.Equal(t, 200, code, body)
	assert.Equal(t, 3, a.Total, "the job run, the manual workflow run, the scheduled one with no job run id")
	kinds := []string{}
	for _, r := range a.Runs {
		kinds = append(kinds, fmt.Sprint(r["kind"]))
	}
	assert.Equal(t, []string{"job", "workflow", "workflow"}, kinds)
}

func TestAutomationRunsRowsCarryWhatTheOldReadsCarried(t *testing.T) {
	f := newRunsFixture(t)
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	job := f.job(t, "nightly-job")
	f.jobRun(t, job, at, "failed")
	wf := f.workflow(t, "wf-name")
	f.workflowRun(t, wf, at.Add(-time.Hour), "manual", nil)
	_, a, body := f.get(t, url.Values{})
	require.Len(t, a.Runs, 2, body)
	j, w := a.Runs[0], a.Runs[1]
	assert.Equal(t, "job", j["kind"])
	assert.Equal(t, "nightly-job", j["job_name"], "the job's name, as the recent read gave it")
	assert.Equal(t, "failed", j["status"])
	assert.NotNil(t, j["scheduled_at"])
	assert.Equal(t, "workflow", w["kind"])
	assert.Equal(t, "wf-name", w["workflow_name"])
	assert.EqualValues(t, wf, w["workflow_id"])
}

// QA Reviewer 2's SHOULD on #13183: a job run and a workflow run with the SAME time and the SAME id (their ids come from two tables, so id 1 exists in both) are told apart by the cursor's kind, or a page boundary between
// them loses one. One run of each kind at one instant, a page of one: both are returned, once each, and in the order the list promises (kind, descending, after time and id).
func TestAutomationRunsCursorTellsAJobRunFromAWorkflowRunOfTheSameTimeAndId(t *testing.T) {
	f := newRunsFixture(t)
	at := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	jobRunID := f.jobRun(t, f.job(t, "one-job"), at, "completed")
	wfRunID := f.workflowRun(t, f.workflow(t, "one-workflow"), at, "manual", nil)
	require.Equal(t, jobRunID, wfRunID, "the premise: both tables hand out id 1 first, so the two runs share time and id")

	var kinds []string
	cursor := ""
	for page := 0; page < 4; page++ {
		p := url.Values{"limit": {"1"}}
		if cursor != "" {
			p.Set("cursor", cursor)
		}
		code, a, body := f.get(t, p)
		require.Equal(t, 200, code, body)
		assert.Equal(t, 2, a.Total)
		for _, r := range a.Runs {
			kinds = append(kinds, fmt.Sprint(r["kind"]))
		}
		if !a.HasMore {
			break
		}
		cursor = a.NextCursor
	}
	assert.Equal(t, []string{"workflow", "job"}, kinds, "both runs, once each, across the boundary between them")
}
