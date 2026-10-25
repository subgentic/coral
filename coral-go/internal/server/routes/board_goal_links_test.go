package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/redact"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #7364, the Hub's service-only per-machine read (GET /api/goal-links?request_id=<id>): only a stream Coral Hub's own service stamped, exactly one request id and nothing else but a cursor, the tasks made
// by accepting that request for the asker the stream names, redacted, paged, never cached.
func goalLinksEnv(t *testing.T) (*BoardHandler, string, *board.Task) {
	t.Helper()
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	g, err := h.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Goal", CreatedBy: "Operator"})
	require.NoError(t, err)
	on := true
	_, err = h.bs.UpdateBoardSettings(ctx, "beta", board.BoardSettingsUpdate{GoalRequests: &on})
	require.NoError(t, err)
	_, in, err := h.bs.SendGoalRequest(ctx, "alpha", g.ID, "beta", "do it", "Lead", nil)
	require.NoError(t, err)
	task, _, err := h.bs.AcceptGoalRequest(ctx, "beta", in.ID, "Build the importer ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789", "body", "high", "Orch", "Dev B")
	require.NoError(t, err)
	return h, in.RequestID, task
}

type goalLinksCall struct {
	query   string
	mutate  func(*http.Request)
	service bool   // the connector's stamp: authentic via, service flag and asker
	server  string // the asker's server
	board   string // the asker's board
}

func (c goalLinksCall) do(h *BoardHandler) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/api/goal-links?"+c.query, nil)
	if c.service {
		r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
		r.Header.Set(tunnel.HubServiceHeader, "1")
		r.Header.Set(tunnel.HubAskServerHeader, c.server)
		r.Header.Set(tunnel.HubAskBoardHeader, c.board)
	}
	if c.mutate != nil {
		c.mutate(r)
	}
	rec := httptest.NewRecorder()
	h.GoalLinks(rec, r)
	return rec
}

func TestGoalLinksIsForTheHubsServiceStreamOnly(t *testing.T) {
	h, rid, _ := goalLinksEnv(t)
	q := "request_id=" + url.QueryEscape(rid)
	good := goalLinksCall{query: q, service: true, board: "alpha"}.do(h)
	require.Equal(t, http.StatusOK, good.Code, good.Body.String())

	for name, c := range map[string]goalLinksCall{
		"a local program, no stamp at all": {query: q},
		"a local program that sends the headers": {query: q, mutate: func(r *http.Request) {
			r.Header.Set(tunnel.HubServiceHeader, "1")
			r.Header.Set(tunnel.HubAskBoardHeader, "alpha")
		}},
		"an agent's token": {query: q, mutate: func(r *http.Request) { r.Header.Set("X-Coral-Session-Token", "agent-token") }},
		"a forged via stamp with the service headers": {query: q, mutate: func(r *http.Request) {
			r.Header.Set(tunnel.ViaHeader, "1")
			r.Header.Set(tunnel.HubServiceHeader, "1")
			r.Header.Set(tunnel.HubAskBoardHeader, "alpha")
		}},
		"the hub owner (authentic via, no service stamp)": {query: q, mutate: func(r *http.Request) {
			r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
			r.Header.Set(tunnel.HubRoleHeader, "owner")
		}},
		"a viewer (authentic via only)": {query: q, mutate: func(r *http.Request) { r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret()) }},
		"authentic via, the flag, but no board": {query: q, mutate: func(r *http.Request) {
			r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
			r.Header.Set(tunnel.HubServiceHeader, "1")
		}},
		"authentic via, a board, but no flag": {query: q, mutate: func(r *http.Request) {
			r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
			r.Header.Set(tunnel.HubAskBoardHeader, "alpha")
		}},
		"the flag is not exactly 1": {query: q, mutate: func(r *http.Request) {
			r.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
			r.Header.Set(tunnel.HubServiceHeader, "true")
			r.Header.Set(tunnel.HubAskBoardHeader, "alpha")
		}},
	} {
		rec := c.do(h)
		assert.Equal(t, http.StatusForbidden, rec.Code, name)
		assert.JSONEq(t, `{"error":"service_only","code":"service_only"}`, rec.Body.String(), name)
		assert.NotContains(t, rec.Body.String(), "Build the importer", name)
	}
}

func TestGoalLinksTakesExactlyOneRequestIDAndNothingButACursorAndALimit(t *testing.T) {
	h, rid, _ := goalLinksEnv(t)
	enc := url.QueryEscape(rid)
	for name, q := range map[string]string{
		"none":                    "",
		"empty":                   "request_id=",
		"two request ids":         "request_id=" + enc + "&request_id=" + enc,
		"a goal uid":              "goal_uid=x",
		"a goal uid beside it":    "request_id=" + enc + "&goal_uid=x",
		"a limit over the max":    "request_id=" + enc + "&limit=101",
		"a limit of zero":         "request_id=" + enc + "&limit=0",
		"a negative limit":        "request_id=" + enc + "&limit=-1",
		"a limit with a sign":     "request_id=" + enc + "&limit=%2B5",
		"a padded limit":          "request_id=" + enc + "&limit=05",
		"a limit that is text":    "request_id=" + enc + "&limit=ten",
		"an empty limit":          "request_id=" + enc + "&limit=",
		"two limits":              "request_id=" + enc + "&limit=5&limit=6",
		"a board":                 "request_id=" + enc + "&board=beta",
		"an asker in the query":   "request_id=" + enc + "&asker_board=alpha&asker_server=x",
		"two cursors":             "request_id=" + enc + "&cursor=a&cursor=b",
		"an unknown cursor":       "request_id=" + enc + "&cursor=not-a-cursor",
		"an overlong cursor":      "request_id=" + enc + "&cursor=" + strings.Repeat("A", board.GoalLinksMaxCursor+1),
		"a short request id":      "request_id=" + rid[:31],
		"a long request id":       "request_id=" + rid + "0",
		"an upper-case id":        "request_id=" + strings.ToUpper(enc),
		"a text request id":       "request_id=nope",
		"a control character":     "request_id=a%00b",
		"a different case of key": "REQUEST_ID=" + enc,
	} {
		rec := goalLinksCall{query: q, service: true, board: "alpha"}.do(h)
		assert.Equal(t, http.StatusBadRequest, rec.Code, "%s: %s", name, rec.Body.String())
		assert.JSONEq(t, `{"error":"bad_request","code":"bad_request"}`, rec.Body.String(), name+": the code and nothing else")
	}
	// a limit of 1 and of 100 are fine
	for _, l := range []string{"1", "100"} {
		rec := goalLinksCall{query: "request_id=" + enc + "&limit=" + l, service: true, board: "alpha"}.do(h)
		assert.Equal(t, http.StatusOK, rec.Code, l)
	}
}

func TestGoalLinksAnswersTheAcceptedRequestsOfThatAskerAndNothingElse(t *testing.T) {
	h, rid, task := goalLinksEnv(t)
	q := "request_id=" + url.QueryEscape(rid)
	rec := goalLinksCall{query: q, service: true, board: "alpha"}.do(h)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var got struct {
		RequestID string           `json:"request_id"`
		Rows      []map[string]any `json:"accepted_requests"`
		Total     int              `json:"accepted_requests_total"`
		Next      *string          `json:"next_cursor"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	assert.Equal(t, rid, got.RequestID)
	assert.Equal(t, 1, got.Total)
	assert.Nil(t, got.Next)
	require.Len(t, got.Rows, 1)
	l := got.Rows[0]
	assert.EqualValues(t, task.ID, l["task_id"])
	assert.Equal(t, "Build the importer "+redact.Marker, l["title"], "the title's token is redacted")
	assert.NotContains(t, rec.Body.String(), "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789")
	assert.Equal(t, "pending", l["task_status"])
	assert.Equal(t, "accepted", l["request_state"])
	assert.Equal(t, "Dev B", l["assignee"])
	assert.Equal(t, "beta", l["board"])
	assert.Equal(t, rid, l["request_id"])
	assert.Len(t, l, 10, "request_id, board, goal_uid, task_id, task_status, request_state, accepted_at, title, assignee, updated_at and nothing else: %v", l)

	// another asker (board or server) and an unknown request id: an empty answer, the same one, so the read says nothing about whose request it is
	for name, c := range map[string]goalLinksCall{
		"another board":  {query: q, service: true, board: "gamma"},
		"another server": {query: q, service: true, server: "srv-x", board: "alpha"},
		"an unknown id":  {query: "request_id=" + strings.Repeat("0", 32), service: true, board: "alpha"},
	} {
		r := c.do(h)
		require.Equal(t, http.StatusOK, r.Code, name)
		assert.JSONEq(t, `{"request_id":"`+strings.Repeat("0", 32)+`","accepted_requests":[],"accepted_requests_total":0,"next_cursor":null}`, strings.ReplaceAll(r.Body.String(), rid, strings.Repeat("0", 32)), name)
	}
}

func TestGoalLinksNamesTheSwitchOffAsA409ForTheAskersOwnRequestOnly(t *testing.T) {
	h, rid, _ := goalLinksEnv(t)
	off := false
	_, err := h.bs.UpdateBoardSettings(context.Background(), "beta", board.BoardSettingsUpdate{GoalRequests: &off})
	require.NoError(t, err)
	q := "request_id=" + url.QueryEscape(rid)
	rec := goalLinksCall{query: q, service: true, board: "alpha"}.do(h)
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.JSONEq(t, `{"error":"goal_requests_off","code":"goal_requests_off"}`, rec.Body.String())
	other := goalLinksCall{query: q, service: true, board: "gamma"}.do(h)
	assert.Equal(t, http.StatusOK, other.Code, "another asker is told nothing of it")
}

func TestGoalLinksLimitsEachAskerAndAnswers429(t *testing.T) {
	h, rid, _ := goalLinksEnv(t)
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	h.goalLinks.now = func() time.Time { return now }
	q := "request_id=" + url.QueryEscape(rid)
	for i := 0; i < goalLinksBurst; i++ {
		require.Equal(t, http.StatusOK, goalLinksCall{query: q, service: true, board: "alpha"}.do(h).Code, "read %d", i)
	}
	rec := goalLinksCall{query: q, service: true, board: "alpha"}.do(h)
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.JSONEq(t, `{"error":"too_many_requests","code":"too_many_requests"}`, rec.Body.String())
	assert.NotEmpty(t, rec.Header().Get("Retry-After"))
	assert.Equal(t, http.StatusOK, goalLinksCall{query: q, service: true, board: "gamma"}.do(h).Code, "another asker has its own allowance")
	now = now.Add(goalLinksWindow + time.Second)
	assert.Equal(t, http.StatusOK, goalLinksCall{query: q, service: true, board: "alpha"}.do(h).Code, "the window passes")
}

func TestGoalLinksSaysUnavailableWhenTheReadFails(t *testing.T) {
	h, rid, _ := goalLinksEnv(t)
	require.NoError(t, h.bs.Close())
	rec := goalLinksCall{query: "request_id=" + url.QueryEscape(rid), service: true, board: "alpha"}.do(h)
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.JSONEq(t, `{"error":"unavailable","code":"unavailable"}`, rec.Body.String())
}
