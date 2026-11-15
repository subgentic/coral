package routes

import (
	"net/http"
	"time"
)

// maxAway is how far back "while you were away" looks: a person who has been gone for longer than a day gets the day.
const maxAway = 24 * time.Hour

// Away answers GET /api/away?since=<RFC3339>: what happened on this computer's boards since that time, as counts only (tasks done, goals done), for the Needs you line "While you were away" (#17537). The person's
// alone, like the Activity record; it names no task, team or agent, and it never goes through the Hub (the page of another computer asks that computer).
func (h *BoardHandler) Away(w http.ResponseWriter, r *http.Request) {
	if !operatorOnlyRead(w, r) {
		return
	}
	now := time.Now()
	since, err := time.Parse(time.RFC3339Nano, r.URL.Query().Get("since"))
	if err != nil || since.After(now) {
		errBadRequest(w, "since is a time in the past, like 2026-11-15T10:00:00Z")
		return
	}
	if now.Sub(since) > maxAway {
		since = now.Add(-maxAway)
	}
	a, err := h.bs.AwayCounts(r.Context(), since)
	if err != nil {
		errInternalServer(w, "could not read what happened")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"since": since.UTC().Format(time.RFC3339), "tasks_done": a.TasksDone, "goals_done": a.GoalsDone})
}
