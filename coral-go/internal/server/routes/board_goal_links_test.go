package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

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
	_, in, err := h.bs.SendGoalRequest(ctx, "alpha", g.ID, "beta", "do it", "Lead", nil)
	require.NoError(t, err)
	task, _, err := h.bs.AcceptGoalRequest(ctx, "beta", in.ID, "Build the importer ghp_abcdefghijklmnopqrstuvwxyz0123456789", "body", "high", "Orch", "Dev B")
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
		assert.Contains(t, rec.Body.String(), "service_only", name)
		assert.NotContains(t, rec.Body.String(), "Build the importer", name)
	}
}

func TestGoalLinksTakesExactlyOneRequestIDAndNothingButACursor(t *testing.T) {
	h, rid, _ := goalLinksEnv(t)
	enc := url.QueryEscape(rid)
	for name, q := range map[string]string{
		"none":                    "",
		"empty":                   "request_id=",
		"two request ids":         "request_id=" + enc + "&request_id=" + enc,
		"a goal uid":              "goal_uid=x",
		"a goal uid beside it":    "request_id=" + enc + "&goal_uid=x",
		"a limit":                 "request_id=" + enc + "&limit=1000",
		"a board":                 "request_id=" + enc + "&board=beta",
		"an asker in the query":   "request_id=" + enc + "&asker_board=alpha&asker_server=x",
		"two cursors":             "request_id=" + enc + "&cursor=a&cursor=b",
		"an unknown cursor":       "request_id=" + enc + "&cursor=not-a-cursor",
		"an overlong request id":  "request_id=" + strings.Repeat("a", 129),
		"a control character":     "request_id=a%00b",
		"a different case of key": "REQUEST_ID=" + enc,
	} {
		rec := goalLinksCall{query: q, service: true, board: "alpha"}.do(h)
		assert.Equal(t, http.StatusBadRequest, rec.Code, "%s: %s", name, rec.Body.String())
		assert.NotContains(t, rec.Body.String(), "Build the importer", name)
	}
}

func TestGoalLinksAnswersTheTasksOfThatRequestForThatAskerAndNothingElse(t *testing.T) {
	h, rid, task := goalLinksEnv(t)
	q := "request_id=" + url.QueryEscape(rid)
	rec := goalLinksCall{query: q, service: true, board: "alpha"}.do(h)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var got struct {
		Links []map[string]any `json:"links"`
		Next  string           `json:"next_cursor"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Len(t, got.Links, 1)
	l := got.Links[0]
	assert.EqualValues(t, task.ID, l["id"])
	assert.Equal(t, "Build the importer "+redact.Marker, l["title"], "the title's token is redacted")
	assert.NotContains(t, rec.Body.String(), "ghp_abcdefghijklmnopqrstuvwxyz0123456789")
	assert.Equal(t, "pending", l["state"])
	assert.Equal(t, "Dev B", l["assignee"])
	assert.Equal(t, "beta", l["board"])
	assert.Len(t, l, 6, "id, title, state, assignee, updated_at, board and nothing else: %v", l)
	assert.Empty(t, got.Next)

	// another asker (board or server) and an unknown request id: an empty page, the same answer, so the read says nothing about whose request it is
	for name, c := range map[string]goalLinksCall{
		"another board":  {query: q, service: true, board: "gamma"},
		"another server": {query: q, service: true, server: "srv-x", board: "alpha"},
		"an unknown id":  {query: "request_id=nope", service: true, board: "alpha"},
		"the id in caps": {query: "request_id=" + strings.ToUpper(url.QueryEscape(rid)), service: true, board: "alpha"},
	} {
		r := c.do(h)
		require.Equal(t, http.StatusOK, r.Code, name)
		assert.JSONEq(t, `{"links":[]}`, r.Body.String(), name)
	}
}
