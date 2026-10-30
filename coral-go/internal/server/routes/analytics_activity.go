package routes

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
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

	// The counts of an hour-aligned window are the same for the whole hour, and finding them reads the text of up to 50000 messages (to see who they @mention): a tab that polls, or two tabs, must not
	// repeat it (Security's #11225 SHOULD 1). So the answer is kept per (team, range, window end) until the hour is over; the touches, a cheap grouped read, are not, so a touch shows at once.
	mu     sync.Mutex
	cached map[string]activityEntry
	scans  atomic.Int64 // how many times the messages were scanned (a test reads it)
}

type activityEntry struct {
	activity  board.Activity
	taskMsgs  *[]board.TaskMessages
	truncated bool
}

// maxCachedActivities bounds the entries kept (a team and a range each): a few teams and four ranges.
const maxCachedActivities = 64

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
	if refuseNonOwner(w, r) { // through Coral Hub the owner's alone (#11225, Security's MUST): the reply is how hands-on the Operator is and what each agent did
		return
	}
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
	key := team + "|" + rng + "|" + until.Format(time.RFC3339)
	a, taskMsgs, truncated, err := h.counted(r.Context(), key, team, since.Format(time.RFC3339), until.Format(time.RFC3339))
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
	a.TaskMessages = taskMsgs
	a.Truncated = a.Truncated || truncated
	writeJSON(w, http.StatusOK, map[string]any{"range": rng, "generated_at": now.Format(time.RFC3339), "activity": a})
}

// counted is the window's counts (the messages' scan and the task messages): from the hour's cache when it is there, else read and kept. A read that fails is not kept.
func (h *ActivityHandler) counted(ctx context.Context, key, team, since, until string) (*board.Activity, *[]board.TaskMessages, bool, error) {
	h.mu.Lock()
	if e, ok := h.cached[key]; ok {
		h.mu.Unlock()
		a := e.activity // a copy: the caller adds the touches
		return &a, e.taskMsgs, e.truncated, nil
	}
	h.mu.Unlock()
	a, err := h.bs.BoardActivity(ctx, team, since, until)
	if err != nil {
		return nil, nil, false, err
	}
	h.scans.Add(1)
	var taskMsgs *[]board.TaskMessages
	truncated := false
	if tm, tr, terr := h.bs.TaskMessageCounts(ctx, team, since, until); terr != nil {
		slog.Error("activity task messages read failed", "error", terr) // left out of the reply: the tab says "not recorded yet" for it
	} else {
		if tm == nil {
			tm = []board.TaskMessages{}
		}
		taskMsgs, truncated = &tm, tr
	}
	h.mu.Lock()
	if h.cached == nil || len(h.cached) >= maxCachedActivities {
		h.cached = map[string]activityEntry{} // a new hour (the keys carry the window's end), or too many: start again
	}
	h.cached[key] = activityEntry{activity: *a, taskMsgs: taskMsgs, truncated: truncated}
	h.mu.Unlock()
	return a, taskMsgs, truncated, nil
}
