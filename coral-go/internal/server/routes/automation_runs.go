package routes

import (
	"errors"
	"net/http"
	"strings"

	"github.com/subgentic/coral/internal/store"
)

// automationJobRun and automationWorkflowRun are the two kinds of run of the Recent runs list, each as the old reads gave it with the kind added (the page tells them apart by it).
type automationJobRun struct {
	Kind string `json:"kind"`
	store.ScheduledRun
}

type automationWorkflowRun struct {
	Kind string `json:"kind"`
	store.WorkflowRun
}

// AutomationRuns is one page of every run of every job and every workflow, newest first (#13183, the Operator's Recent runs: it showed the last 100 of a job that runs every minute and nothing else).
// GET /api/automations/runs?limit&cursor&q&result&unread
//
//	limit   at most 50 (the default and the most); more is cut to it
//	cursor  the next_cursor of the page before; none is the first page. A cursor made for other filters, or one this read did not make, is a 400
//	q       a case-insensitive substring of the run's job or workflow name, or of its status word, applied before the cut
//	result  passed, failed or running, applied before the cut
//	unread  1: the finished runs nobody has opened
//
// The answer is {runs, has_more, next_cursor, total}: total is the number of runs the filters match, whatever the page. A workflow run a scheduled job started is not listed: the job's run stands for it (as the page
// merged them before).
func (h *ScheduleHandler) AutomationRuns(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := clampLimit(queryInt(r, "limit", store.RunsPageMax), store.RunsPageMax, store.RunsPageMax)
	unread := false
	switch strings.ToLower(q.Get("unread")) {
	case "", "0", "false":
	case "1", "true":
		unread = true
	default:
		errBadRequest(w, "unread is 1 or empty")
		return
	}
	page, err := h.sched.RunsPage(r.Context(), store.RunsPageQuery{Limit: limit, Cursor: q.Get("cursor"), Q: q.Get("q"), Result: q.Get("result"), Unread: unread})
	if err != nil {
		if errors.Is(err, store.ErrBadRunsPageQuery) {
			errBadRequest(w, strings.TrimPrefix(err.Error(), store.ErrBadRunsPageQuery.Error()+": "))
			return
		}
		errInternalServer(w, err.Error())
		return
	}
	jobs, wfs, err := h.sched.RunsPageRows(r.Context(), page.Keys)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	runs := make([]any, 0, len(page.Keys))
	for _, k := range page.Keys {
		if k.Kind == "workflow" {
			if run, ok := wfs[k.ID]; ok {
				runView(&run)
				runs = append(runs, automationWorkflowRun{Kind: "workflow", WorkflowRun: run})
			}
		} else if run, ok := jobs[k.ID]; ok {
			runs = append(runs, automationJobRun{Kind: "job", ScheduledRun: run})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs, "has_more": page.HasMore, "next_cursor": page.NextCursor, "total": page.Total})
}
