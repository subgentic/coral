package routes

import (
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/limitwaits"
)

// GET /api/analytics/limit-waits?days=&team= (feature bets stage 1, task 2, #21020): the limit waits of the agents on the cost page: how many times an agent was stopped by its vendor's usage limit, how many
// of those it resumed at the reset time (or after it) and how many earlier, per agent and day, for a range of days and, when asked, one team. NUMBERS AND NAMES ONLY: an agent's name, a day and three counts;
// no message, command, path or CLI text. The days are this computer's days (a wait counts on the day it began, and so does how it ended). The Operator's alone and read only, like the resource queue's
// read: through Coral Hub the owner's alone, never an agent's. A computer whose record could not be opened answers tracking:false with nothing counted.

// LimitWaitsHandler serves the read.
type LimitWaitsHandler struct {
	mu  sync.Mutex
	st  *limitwaits.Store
	now func() time.Time
	loc *time.Location // tests; nil is this computer's zone
}

// NewLimitWaitsHandler creates the handler; the store may be nil (the record could not be opened) and set later.
func NewLimitWaitsHandler(st *limitwaits.Store) *LimitWaitsHandler { return &LimitWaitsHandler{st: st} }

// SetStore gives the handler the record it reads.
func (h *LimitWaitsHandler) SetStore(st *limitwaits.Store) {
	h.mu.Lock()
	h.st = st
	h.mu.Unlock()
}

func (h *LimitWaitsHandler) store() *limitwaits.Store {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.st
}

// Read is GET /api/analytics/limit-waits.
func (h *LimitWaitsHandler) Read(w http.ResponseWriter, r *http.Request) {
	if !operatorOnlyRead(w, r) {
		return
	}
	days := 7
	if v := r.URL.Query().Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			errBadRequest(w, "days is a positive number")
			return
		}
		days = n
	}
	if days > limitwaits.KeepDays {
		days = limitwaits.KeepDays
	}
	team := r.URL.Query().Get("team")
	if team != "" && !commentBoardRe.MatchString(team) {
		errBadRequest(w, "team must be a team name")
		return
	}
	now := time.Now()
	if h.now != nil {
		now = h.now()
	}
	loc := time.Local
	if h.loc != nil {
		loc = h.loc
	}
	now = now.In(loc)
	until := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, 1) // the end of today, this computer's day
	since := until.AddDate(0, 0, -days)
	out := map[string]any{"days_asked": days, "team": team, "generated_at": now.UTC().Format(time.RFC3339), "tracking": false,
		"totals": limitwaits.Totals{}, "rows": []limitwaits.Row{}, "waiting": 0, "teams": []string{}}
	if st := h.store(); st != nil {
		rep, err := st.Counts(since, until, team, loc)
		if err != nil {
			slog.Error("limit waits read failed", "error", err)
			errInternalServer(w, "the read failed")
			return
		}
		out["tracking"], out["totals"], out["rows"], out["waiting"] = true, rep.Totals, rep.Rows, rep.Waiting
		out["teams"] = rep.Teams
	}
	writeJSON(w, http.StatusOK, out)
}
