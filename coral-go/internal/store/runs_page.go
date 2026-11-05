package store

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Recent runs as pages (#13183): every run of every job and every workflow as one newest-first list the computer cuts itself, 50 a request, with the search and the filters applied BEFORE the cut and the
// true total. The page used to read the 100 newest of each kind and merge them in the browser, so a job that runs every minute filled the list and an older run could not be found.
//
// The merge rule is the page's (automation_runs.js mergeRuns): a workflow run that a scheduled job started (trigger "scheduled" with the job run's id in its context) is left out, the job's run stands for it.

// RunsPageMax is the most runs one request returns.
const RunsPageMax = 50

// ErrBadRunsPageQuery is a cursor that is not one this read made, or one made for other filters, or a filter value that is not one of the fixed words.
var ErrBadRunsPageQuery = errors.New("store: bad runs page query")

// Results a request may filter by: the Result words of the Automations filters.
const (
	RunResultPassed  = "passed"
	RunResultFailed  = "failed"
	RunResultRunning = "running"
)

// RunsPageQuery selects a page. Q is a case-insensitive substring of the run's name (job or workflow) or of its status word. Result is "" or one of the fixed Result words. Unread keeps the finished runs nobody opened.
type RunsPageQuery struct {
	Limit  int
	Cursor string
	Q      string
	Result string
	Unread bool
}

// RunKey names one run of the page: its kind ("job" or "workflow") and its id in that kind's table.
type RunKey struct {
	Kind string
	ID   int64
}

// RunsPage is the keys of one page in order, whether there is another, the cursor for it, and the true number of runs the filters match.
type RunsPage struct {
	Keys       []RunKey
	HasMore    bool
	NextCursor string
	Total      int
}

type runsCursor struct {
	At int64  `json:"a"` // the run's time, milliseconds since the epoch (the order key)
	ID int64  `json:"i"`
	K  string `json:"k"`
	F  string `json:"f"` // the filters the cursor was made for
}

func runsFilterKey(q RunsPageQuery) string {
	h := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(q.Q)) + "\x00" + q.Result + "\x00" + fmt.Sprint(q.Unread)))
	return hex.EncodeToString(h[:6])
}

func (c runsCursor) encode() string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeRunsCursor(s string) (runsCursor, error) {
	var c runsCursor
	if len(s) > 1024 {
		return c, fmt.Errorf("%w: cursor too long", ErrBadRunsPageQuery)
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || json.Unmarshal(b, &c) != nil || (c.K != "job" && c.K != "workflow") {
		return c, fmt.Errorf("%w: cursor is not one this read made", ErrBadRunsPageQuery)
	}
	return c, nil
}

// runsUnion is every run as (kind, id, at, name, status, result, seen), at in milliseconds. A run's time is the page's: when it started, else when it was scheduled or created. A job's name is its display name, else its
// job's name (never the one-off sentinel's), else "Job <id>"; a workflow's is its name.
const runsUnion = `
SELECT 'job' AS kind, r.id AS id,
       CAST((julianday(COALESCE(r.started_at, r.scheduled_at, r.created_at)) - 2440587.5) * 86400000 AS INTEGER) AS at,
       LOWER(COALESCE(NULLIF(r.display_name, ''), CASE WHEN j.name = '__oneshot__' THEN NULL ELSE j.name END, 'job ' || r.job_id)) AS name,
       r.status AS status,
       CASE WHEN r.status = 'running' THEN 'running' WHEN r.status IN ('failed', 'killed') THEN 'failed' WHEN r.status = 'completed' THEN 'passed' ELSE '' END AS result,
       r.seen_at AS seen_at
  FROM scheduled_runs r JOIN scheduled_jobs j ON j.id = r.job_id
UNION ALL
SELECT 'workflow', w.id,
       CAST((julianday(COALESCE(w.started_at, w.created_at)) - 2440587.5) * 86400000 AS INTEGER),
       LOWER(wf.name),
       w.status,
       CASE WHEN w.status = 'running' THEN 'running' WHEN w.status IN ('failed', 'killed') THEN 'failed' WHEN w.status = 'completed' THEN 'passed' ELSE '' END,
       w.seen_at
  FROM workflow_runs w JOIN workflows wf ON wf.id = w.workflow_id
 WHERE NOT (w.trigger_type = 'scheduled' AND json_valid(w.trigger_context) AND COALESCE(CAST(json_extract(w.trigger_context, '$.scheduled_run_id') AS INTEGER), 0) > 0)`

// RunsPage reads one page of runs. The filters and the cursor are applied in SQL before the cut; Total counts the runs the filters match, whatever page it is.
func (s *ScheduleStore) RunsPage(ctx context.Context, q RunsPageQuery) (*RunsPage, error) {
	limit := q.Limit
	if limit < 1 || limit > RunsPageMax {
		limit = RunsPageMax
	}
	switch q.Result {
	case "", RunResultPassed, RunResultFailed, RunResultRunning:
	default:
		return nil, fmt.Errorf("%w: result is passed, failed or running", ErrBadRunsPageQuery)
	}
	text := strings.ToLower(strings.TrimSpace(q.Q))
	if len(text) > 200 {
		return nil, fmt.Errorf("%w: q is at most 200 characters", ErrBadRunsPageQuery)
	}
	var where []string
	var args []any
	if text != "" {
		where = append(where, "(instr(name, ?) > 0 OR instr(status, ?) > 0 OR instr(result, ?) > 0)")
		args = append(args, text, text, text)
	}
	if q.Result != "" {
		where = append(where, "result = ?")
		args = append(args, q.Result)
	}
	if q.Unread {
		where = append(where, "status NOT IN ('running', 'pending') AND seen_at IS NULL")
	}
	filters := strings.Join(where, " AND ")
	if filters == "" {
		filters = "1 = 1"
	}
	var total int
	if err := s.db.GetContext(ctx, &total, "SELECT COUNT(*) FROM ("+runsUnion+") WHERE "+filters, args...); err != nil {
		return nil, err
	}
	pageWhere, pageArgs := filters, append([]any(nil), args...)
	if q.Cursor != "" {
		c, err := decodeRunsCursor(q.Cursor)
		if err != nil {
			return nil, err
		}
		if c.F != runsFilterKey(q) {
			return nil, fmt.Errorf("%w: cursor is for other filters", ErrBadRunsPageQuery)
		}
		pageWhere += " AND (at < ? OR (at = ? AND id < ?) OR (at = ? AND id = ? AND kind < ?))"
		pageArgs = append(pageArgs, c.At, c.At, c.ID, c.At, c.ID, c.K)
	}
	type row struct {
		Kind string `db:"kind"`
		ID   int64  `db:"id"`
		At   int64  `db:"at"`
	}
	var rows []row
	err := s.db.SelectContext(ctx, &rows, "SELECT kind, id, COALESCE(at, 0) AS at FROM ("+runsUnion+") WHERE "+pageWhere+" ORDER BY COALESCE(at, 0) DESC, id DESC, kind DESC LIMIT ?", append(pageArgs, limit+1)...)
	if err != nil {
		return nil, err
	}
	out := &RunsPage{Total: total}
	if len(rows) > limit {
		out.HasMore = true
		rows = rows[:limit]
	}
	for _, r := range rows {
		out.Keys = append(out.Keys, RunKey{Kind: r.Kind, ID: r.ID})
	}
	if out.HasMore {
		last := rows[len(rows)-1]
		out.NextCursor = runsCursor{At: last.At, ID: last.ID, K: last.Kind, F: runsFilterKey(q)}.encode()
	}
	return out, nil
}

// RunsPageRows reads the whole rows of a page's keys: the job runs with their job's name (as the recent-runs read gives them) and the workflow runs with their workflow's name, each by id.
func (s *ScheduleStore) RunsPageRows(ctx context.Context, keys []RunKey) (map[int64]ScheduledRun, map[int64]WorkflowRun, error) {
	var jobIDs, wfIDs []any
	for _, k := range keys {
		if k.Kind == "workflow" {
			wfIDs = append(wfIDs, k.ID)
		} else {
			jobIDs = append(jobIDs, k.ID)
		}
	}
	jobs, wfs := map[int64]ScheduledRun{}, map[int64]WorkflowRun{}
	marks := func(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }
	if len(jobIDs) > 0 {
		var rs []ScheduledRun
		if err := s.db.SelectContext(ctx, &rs, `SELECT r.*, `+runJobNameSQL+` as job_name FROM scheduled_runs r JOIN scheduled_jobs j ON j.id = r.job_id WHERE r.id IN (`+marks(len(jobIDs))+`)`, jobIDs...); err != nil {
			return nil, nil, err
		}
		for _, r := range rs {
			jobs[r.ID] = r
		}
	}
	if len(wfIDs) > 0 {
		var rs []WorkflowRun
		if err := s.db.SelectContext(ctx, &rs, `SELECT r.*, w.name as workflow_name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id IN (`+marks(len(wfIDs))+`)`, wfIDs...); err != nil {
			return nil, nil, err
		}
		for _, r := range rs {
			wfs[r.ID] = r
		}
	}
	return jobs, wfs, nil
}
