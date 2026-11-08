package routes

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// GET /api/thread?team=&goal=|&task=[&order=&limit=&after=] and GET /api/threads?team=[&goal=&state=&limit=&after=] (goal #233, S3, #14440; the design note
// coral://artifacts/7308bfa149eb7b7b8e8566f40dc9d691851f042b3e4cc0b3e76334401209403d). Owner only, like /api/activity and /api/needs-you: the person at this computer, and through Coral Hub the
// account the computer is linked to and nobody else. An agent's token is refused (class b). Strict: team is required and validated, goal and task are numbers, state and order are closed sets, an
// unknown key is refused (the tunnel's own list names the same keys), the cursor is the one the read gave, and exactly one of goal or task selects a thread. The text in an answer is redacted
// before it is cut (redactComment; a text that fails is "(text withheld)").

var (
	threadKeys  = map[string]bool{"team": true, "goal": true, "task": true, "order": true, "limit": true, "after": true}
	threadsKeys = map[string]bool{"team": true, "goal": true, "state": true, "limit": true, "after": true}
)

// threadParams validates the query. ok is false when it answered.
func threadParams(w http.ResponseWriter, q url.Values, keys map[string]bool) (team string, goal int64, limit int, ok bool) {
	for k := range q {
		if !keys[k] {
			errBadRequest(w, "unknown query key: "+k)
			return
		}
	}
	team = q.Get("team")
	if team == "" || !commentBoardRe.MatchString(team) {
		errBadRequest(w, "team is required and must be a team name")
		return
	}
	var good bool
	if goal, good = threadNumber(w, "goal", q.Get("goal")); !good {
		return
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			errBadRequest(w, "invalid limit")
			return
		}
		limit = n // more than board.ThreadMaxLimit is cut to it
	}
	return team, goal, limit, true
}

// threadNumber is an optional positive number of the query (0 when it is not there); ok is false when it answered. The caller reads the key with a literal call on its own url.Values, because
// tools/gen_route_queries.py builds the tunnel's allowlist of keys from those calls: a key read by name inside a helper is missing from it (#14472: the table listed goal and task, the generator found neither).
// Keep a key's name out of this comment: the generator reads comments too.
func threadNumber(w http.ResponseWriter, key, v string) (int64, bool) {
	if v == "" {
		return 0, true
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		errBadRequest(w, "invalid "+key)
		return 0, false
	}
	return n, true
}

// threadActor is the actor a team's Hub owner reads alone (their own Activity rows, #12070), "" for this computer's own person or a personal machine: the rule ListActivity applies.
func threadActor(r *http.Request) string {
	if cloud.Tunneled(r) || r.Header.Get(tunnel.ViaHeader) != "" {
		if id := hubOwnerRequest(r); id.team {
			return activityActor(id)
		}
	}
	return ""
}

func threadErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, board.ErrThreadNotFound):
		writeError(w, http.StatusNotFound, "not_found", "no such goal or task on this team")
	case errors.Is(err, board.ErrThreadCursor):
		errBadRequest(w, "invalid after")
	default:
		errInternalServer(w, "could not read the thread")
	}
}

// Thread is GET /api/thread: the entries of one goal or one task.
func (h *BoardHandler) Thread(w http.ResponseWriter, r *http.Request) {
	if !operatorOnly(w, r) {
		return
	}
	q := r.URL.Query()
	team, goal, limit, ok := threadParams(w, q, threadKeys)
	if !ok {
		return
	}
	task, good := threadNumber(w, "task", q.Get("task"))
	if !good {
		return
	}
	if goal == 0 && task == 0 {
		errBadRequest(w, "goal or task is required")
		return
	}
	order := q.Get("order")
	if order != "" && order != "asc" && order != "desc" {
		errBadRequest(w, "invalid order")
		return
	}
	page, err := h.bs.ThreadEntries(r.Context(), board.ThreadQuery{Team: team, GoalID: goal, TaskID: task, Order: order, Limit: limit, After: q.Get("after"), Redact: redactComment, Actor: threadActor(r)})
	if err != nil {
		threadErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// Threads is GET /api/threads: one summary per task, for the list pages.
func (h *BoardHandler) Threads(w http.ResponseWriter, r *http.Request) {
	if !operatorOnly(w, r) {
		return
	}
	q := r.URL.Query()
	team, goal, limit, ok := threadParams(w, q, threadsKeys) // task is not one of the summaries' keys: threadParams refuses it as unknown already
	if !ok {
		return
	}
	state := q.Get("state")
	if state != "" && state != "waiting" && state != "decided" && state != "all" {
		errBadRequest(w, "invalid state")
		return
	}
	page, err := h.bs.ThreadSummaries(r.Context(), board.ThreadsQuery{Team: team, GoalID: goal, State: state, Limit: limit, After: q.Get("after"), Redact: redactComment, Actor: threadActor(r)})
	if err != nil {
		threadErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}
