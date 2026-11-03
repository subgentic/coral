package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

type waitingRig struct {
	t      *testing.T
	url    string
	h      *SessionsHandler
	sid    string
	name   string
	tok    string
	ids    []int64
	unread func() int
}

// An Orchestrator (receive mode all) with Coral Task Queue's audit rows and Coral's notices to other agents before and among its real unread messages.
func newWaitingRig(t *testing.T) *waitingRig {
	t.Helper()
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "22222222-2222-3333-4444-555555555555"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "Lead", AgentType: "claude", WorkingDir: t.TempDir()}))
	name := naming.SessionName("claude", sid)
	_, err := h.bs.Subscribe(ctx, "alpha", "Lead", "Orchestrator", name, nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "alpha", "Dev", "Backend", "claude-dev", nil, "mentions")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "alpha", "Coral Task Queue", "Queue", "claude-queue", nil, "all")
	require.NoError(t, err)
	post := func(from, text string) {
		m, err := h.bs.PostMessage(ctx, "alpha", from, text, nil)
		require.NoError(t, err)
		_ = m
	}
	for i := 0; i < 6; i++ {
		post("Coral Task Queue", "@Orchestrator audit row never counted")
		post("Dev", "an old chat the Orchestrator reads with a plain read")
	}
	r := &waitingRig{t: t, url: server.URL, h: h, sid: sid, name: name, tok: agentToken(t, h, sid, name)}
	r.unread = func() int { n, _ := h.bs.CheckUnread(ctx, "alpha", "Lead"); return n }
	return r
}

func (r *waitingRig) list() (unread int, ids []int64) {
	r.t.Helper()
	resp, err := http.Get(r.url + "/api/sessions/live/" + r.name + "/waiting?agent_type=claude&session_id=" + r.sid)
	require.NoError(r.t, err)
	defer resp.Body.Close()
	var out struct {
		Unread   int `json:"unread"`
		Messages []struct {
			ID     int64  `json:"id"`
			Sender string `json:"sender"`
		} `json:"messages"`
	}
	require.NoError(r.t, json.NewDecoder(resp.Body).Decode(&out))
	for _, m := range out.Messages {
		assert.NotEqual(r.t, "Coral Task Queue", m.Sender, "an audit row is never listed: the count never counted it")
		ids = append(ids, m.ID)
	}
	return out.Unread, ids
}

func (r *waitingRig) dismiss(through int64, token string) (int, map[string]any) {
	r.t.Helper()
	b, _ := json.Marshal(map[string]any{"agent_type": "claude", "session_id": r.sid, "through_id": through})
	req, _ := http.NewRequest("POST", r.url+"/api/sessions/live/"+r.name+"/waiting/dismiss", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set(store.SessionTokenHeader, token)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(r.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// #12713 (the Operator: the panel said 12 and listed fifty rows back to Oct 26): the list is the messages the count counts, an Orchestrator's included, so the two agree.
func TestTheWaitingListIsTheMessagesTheCountCounts(t *testing.T) {
	r := newWaitingRig(t)
	n, ids := r.list()
	require.Equal(t, r.unread(), n)
	assert.Len(t, ids, n, "the list holds exactly what the count counts: no audit rows, no row the count skips")
	assert.Equal(t, 6, n)
}

// Dismiss marks the listed messages read for the agent: the count and the list go to what came after, and nothing is typed into the agent.
func TestDismissMarksTheListedMessagesReadAndNothingAfterThem(t *testing.T) {
	r := newWaitingRig(t)
	ctx := context.Background()
	_, ids := r.list()
	require.NotEmpty(t, ids)
	newest := ids[len(ids)-1]
	_, err := r.h.bs.PostMessage(ctx, "alpha", "Dev", "a new message after the list was read", nil)
	require.NoError(t, err)
	status, out := r.dismiss(newest, "")
	require.Equal(t, http.StatusOK, status, out)
	assert.EqualValues(t, 6, out["dismissed"])
	assert.EqualValues(t, 1, out["unread"], "the message that came after the list stays unread")
	n, left := r.list()
	assert.Equal(t, 1, n)
	assert.Len(t, left, 1)
	status, out = r.dismiss(newest, "")
	assert.Equal(t, http.StatusOK, status)
	assert.EqualValues(t, 0, out["dismissed"], "again: nothing more is read, the position never moves back")
	assert.Equal(t, 1, r.unread())
}

// A through_id past the board's newest would skip messages not yet written; an agent's token (an Orchestrator's own included) cannot mark another's read; no id says nothing.
func TestDismissRefusesAnIdPastTheNewestAnAgentAndNoId(t *testing.T) {
	r := newWaitingRig(t)
	_, ids := r.list()
	status, _ := r.dismiss(ids[len(ids)-1]+1000, "")
	assert.Equal(t, http.StatusBadRequest, status)
	status, _ = r.dismiss(0, "")
	assert.Equal(t, http.StatusBadRequest, status)
	status, _ = r.dismiss(ids[len(ids)-1], r.tok)
	assert.Equal(t, http.StatusForbidden, status)
	assert.Equal(t, 6, r.unread(), "none of the refused calls moved the read position")
}
