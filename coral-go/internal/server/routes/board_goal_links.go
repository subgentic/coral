package routes

import (
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The Hub's service-only per-machine read (#7364, the #7331 note sections 6, 11 point 4 and 12): GET /api/goal-links?request_id=<id>. Coral Hub shows the tasks another team made for a goal request, and
// only the Hub does: no local Coral reads another machine's rows. It answers the stream Coral Hub's own SERVICE stamped (tunnel/hubservice.go: authentic connector stamp, the service flag, and the server
// and board the request was sent from) and nobody else: an owner, a viewer, an agent and a local program all get 403 service_only. The asker comes from the stamp, never from the query.

// serviceAsker is who the Hub's service says the read is for, when the request is a stream the connector really stamped for the service (cloud.ServiceAsker, which the Guard asks too, #9084).
func serviceAsker(r *http.Request) (tunnel.HubAsker, bool) { return cloud.ServiceAsker(r) }

// The closed list of answers this read gives (#7411, agreed with coral-hub): the body is the code and nothing else, so no machine text crosses; the detail of a 400 (which parameter, a bad cursor) lives in the tests.
const (
	goalLinksBadRequest  = "bad_request"       // 400: the query or the cursor
	goalLinksServiceOnly = "service_only"      // 403
	goalLinksOff         = "goal_requests_off" // 409: the receiving board's switch is off, for a request this asker sent
	goalLinksTooMany     = "too_many_requests" // 429
	goalLinksUnavailable = "unavailable"       // 503: the read failed
)

// goalLinksLimiter allows each asker (server and board) goalLinksBurst reads per goalLinksWindow; the zero value is ready. now is the clock (nil: time.Now), for tests.
type goalLinksLimiter struct {
	mu   sync.Mutex
	seen map[string][]time.Time
	now  func() time.Time
}

const (
	goalLinksBurst  = 30
	goalLinksWindow = 10 * time.Second
	// goalLinksMaxAskers bounds the table: past it, askers with nothing recent are dropped first.
	goalLinksMaxAskers = 4096
)

// allow records a read by asker and reports whether it is within the limit; retry is the seconds until it would be.
func (l *goalLinksLimiter) allow(asker string) (ok bool, retry int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.now != nil {
		now = l.now()
	}
	if l.seen == nil {
		l.seen = map[string][]time.Time{}
	}
	cut := now.Add(-goalLinksWindow)
	keep := l.seen[asker][:0]
	for _, t := range l.seen[asker] {
		if t.After(cut) {
			keep = append(keep, t)
		}
	}
	if len(keep) >= goalLinksBurst {
		l.seen[asker] = keep
		return false, int(keep[0].Sub(cut)/time.Second) + 1
	}
	l.seen[asker] = append(keep, now)
	if len(l.seen) > goalLinksMaxAskers {
		for k, v := range l.seen {
			if k != asker && (len(v) == 0 || !v[len(v)-1].After(cut)) {
				delete(l.seen, k)
			}
		}
	}
	return true, 0
}

// GoalLinks: GET /api/goal-links?request_id=<32 hex>[&cursor=<c>][&limit=<1..100>]. Each parameter at most once; nothing else.
func (h *BoardHandler) GoalLinks(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	asker, ok := serviceAsker(r)
	if !ok {
		writeError(w, http.StatusForbidden, goalLinksServiceOnly, goalLinksServiceOnly)
		return
	}
	if ok, retry := h.goalLinks.allow(asker.Server + "\x00" + asker.Board); !ok {
		httputil.WriteActionLimit(w, retry, goalLinksTooMany, goalLinksTooMany)
		return
	}
	requestID, cursor, limit, ok := goalLinksQuery(r)
	if !ok {
		writeError(w, http.StatusBadRequest, goalLinksBadRequest, goalLinksBadRequest)
		return
	}
	red := requestRedactor(r)
	reply, err := h.bs.GoalLinks(r.Context(), requestID, asker.Server, asker.Board, cursor, limit, func(s string) string {
		if out, rerr := red.Text([]byte(s)); rerr == nil {
			return string(out)
		}
		return "(a title that could not be checked for secrets)"
	})
	switch {
	case errors.Is(err, board.ErrBadGoalLinksQuery):
		writeError(w, http.StatusBadRequest, goalLinksBadRequest, goalLinksBadRequest)
	case errors.Is(err, board.ErrGoalRequestsOff):
		writeError(w, http.StatusConflict, goalLinksOff, goalLinksOff)
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, goalLinksUnavailable, goalLinksUnavailable)
	default:
		writeJSON(w, http.StatusOK, reply)
	}
}

// goalLinksQuery reads the query: exactly one request_id (32 lower-case hex digits), at most one non-empty cursor (at most board.GoalLinksMaxCursor bytes) and at most one limit (decimal 1..board.GoalLinksMaxLimit,
// default board.GoalLinksDefaultLimit); any other parameter, a repeated one, or a key in another case is not a query this read answers.
func goalLinksQuery(r *http.Request) (requestID, cursor string, limit int, ok bool) {
	q := r.URL.Query()
	for k, v := range q {
		if (k != "request_id" && k != "cursor" && k != "limit") || len(v) != 1 {
			return "", "", 0, false
		}
	}
	requestID = q.Get("request_id")
	if !board.ValidGoalRequestID(requestID) {
		return "", "", 0, false
	}
	cursor = q.Get("cursor")
	if _, has := q["cursor"]; has && (cursor == "" || len(cursor) > board.GoalLinksMaxCursor) {
		return "", "", 0, false
	}
	limit = board.GoalLinksDefaultLimit
	if _, has := q["limit"]; has {
		n, err := strconv.Atoi(q.Get("limit"))
		if err != nil || n < 1 || n > board.GoalLinksMaxLimit || strconv.Itoa(n) != q.Get("limit") {
			return "", "", 0, false
		}
		limit = n
	}
	return requestID, cursor, limit, true
}
