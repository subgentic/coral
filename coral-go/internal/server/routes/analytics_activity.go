package routes

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
)

// The Analytics tabs "Operator interaction" and "Team communication" (#11222): one team's counts over a window, from the board's own tables.
//
//	GET /api/analytics/activity?team=<board>&range=7d|14d|30d|90d
//
// Counts only (messages, @mentions, asks, tasks); no message text is returned (board/analytics_activity.go). Through Coral Hub for the owner only: the table row is "launch", so a
// view-only guest's read is refused and the page says so in one line.

var activityRanges = map[string]time.Duration{"7d": 7 * 24 * time.Hour, "14d": 14 * 24 * time.Hour, "30d": 30 * 24 * time.Hour, "90d": 90 * 24 * time.Hour}

// ActivityHandler serves the activity read.
type ActivityHandler struct {
	bs  *board.Store
	now func() time.Time
}

// NewActivityHandler creates the handler.
func NewActivityHandler(bs *board.Store) *ActivityHandler { return &ActivityHandler{bs: bs} }

func (h *ActivityHandler) clock() time.Time {
	if h.now != nil {
		return h.now().UTC()
	}
	return time.Now().UTC()
}

// Activity answers the read.
func (h *ActivityHandler) Activity(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	team := strings.TrimSpace(q.Get("team"))
	if team == "" {
		errBadRequest(w, "team is required")
		return
	}
	rng := q.Get("range")
	if rng == "" {
		rng = "14d"
	}
	dur, ok := activityRanges[rng]
	if !ok {
		errBadRequest(w, "range must be 7d, 14d, 30d or 90d")
		return
	}
	now := h.clock()
	until := now.Truncate(time.Hour).Add(time.Hour) // a whole hour, so a repeat read within it is the same window
	since := until.Add(-dur)
	a, err := h.bs.BoardActivity(r.Context(), team, since.Format(time.RFC3339), until.Format(time.RFC3339))
	if err != nil {
		slog.Error("activity read failed", "error", err) // the detail is the log's: a reply never carries a store's error text
		errInternalServer(w, "the activity read failed")
		return
	}
	// The recording of #11225, in the same read: the Operator's touches (a table of their own: kind, agent, team, time) and the messages per task. A part that cannot be read is left out, and the tab
	// says "not recorded yet" for it.
	if t, err := h.bs.OperatorTouches(r.Context(), team, since.Format(time.RFC3339), until.Format(time.RFC3339)); err != nil {
		slog.Error("activity touches read failed", "error", err)
	} else {
		a.Touches = t
	}
	if tm, truncated, err := h.bs.TaskMessageCounts(r.Context(), team, since.Format(time.RFC3339), until.Format(time.RFC3339)); err != nil {
		slog.Error("activity task messages read failed", "error", err)
	} else {
		if tm == nil {
			tm = []board.TaskMessages{}
		}
		a.TaskMessages = &tm
		a.Truncated = a.Truncated || truncated
	}
	writeJSON(w, http.StatusOK, map[string]any{"range": rng, "generated_at": now.Format(time.RFC3339), "activity": a})
}
