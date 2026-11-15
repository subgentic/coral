package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
)

// sameAsRig is a team with two agents and the Operator, and a poster that goes through the real handler.
func sameAsRig(t *testing.T) (*BoardHandler, *board.Store, func(map[string]any) (int, map[string]any)) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	for _, who := range []string{"Dev A", "Dev B", "Operator"} {
		_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	post := func(body map[string]any) (int, map[string]any) {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/api/board/team/messages", strings.NewReader(string(b)))
		req.Header.Set("Content-Type", "application/json")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		h.PostMessage(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	return h, bs, post
}

func sameAsID(out map[string]any) int64 { return int64(out["id"].(float64)) }

// #17738: a question posted with same_as shares the first one's key in the Operator's list; one answer to either closes both and the other asker is told.
func TestSameAsLinksAsksAndOneAnswerClosesBoth(t *testing.T) {
	h, bs, post := sameAsRig(t)
	code, first := post(map[string]any{"subscriber_id": "Dev A", "content": "@Operator which parser do we ship?", "ask": true})
	require.Equal(t, 200, code, "%v", first)
	code, second := post(map[string]any{"subscriber_id": "Dev B", "content": "@Operator which parser should I use?", "ask": true, "same_as": sameAsID(first)})
	require.Equal(t, 200, code, "%v", second)
	_, alone := post(map[string]any{"subscriber_id": "Dev B", "content": "@Operator unrelated question?", "ask": true})

	_, rows, _ := readOperatorAsks(t, h, asPerson)
	keys := map[int64]float64{}
	for _, r := range rows {
		k, _ := r["key"].(float64)
		keys[int64(r["id"].(float64))] = k
	}
	assert.Equal(t, float64(sameAsID(first)), keys[sameAsID(first)], "the first ask carries its own id as the key")
	assert.Equal(t, float64(sameAsID(first)), keys[sameAsID(second)], "the linked ask shares it")
	assert.Zero(t, keys[sameAsID(alone)], "an ask that is alone has no key")

	code, ans := post(map[string]any{"subscriber_id": "Operator", "content": "@Dev A the new one", "reply_to": sameAsID(first)})
	require.Equal(t, 200, code, "%v", ans)
	_, rows, _ = readOperatorAsks(t, h, asPerson)
	open := map[int64]bool{}
	for _, r := range rows {
		open[int64(r["id"].(float64))] = true
	}
	assert.False(t, open[sameAsID(first)] || open[sameAsID(second)], "both are answered by the one reply: %v", open)
	assert.True(t, open[sameAsID(alone)])

	msgs, err := bs.ListMessages(context.Background(), "team", 50, 0, 0)
	require.NoError(t, err)
	var told string
	for _, m := range msgs {
		if strings.HasPrefix(m.Content, "@Dev B") && strings.Contains(m.Content, "was answered") {
			told = m.Content
		}
	}
	assert.Contains(t, told, "#"+jsonInt(sameAsID(second)), "Dev B is told which of their questions it answered")
	assert.NotContains(t, told, "@Operator", "what the answer quotes calls no one")
}

func jsonInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestSameAsNeedsAnOpenAskAndAnAsk(t *testing.T) {
	_, _, post := sameAsRig(t)
	_, first := post(map[string]any{"subscriber_id": "Dev A", "content": "@Operator which parser?", "ask": true})
	code, out := post(map[string]any{"subscriber_id": "Dev B", "content": "@Operator parser?", "ask": true, "same_as": 99999})
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	code, out = post(map[string]any{"subscriber_id": "Dev B", "content": "@Operator parser?", "same_as": sameAsID(first)})
	assert.Equal(t, http.StatusBadRequest, code, "same_as is for a question: %v", out)
	post(map[string]any{"subscriber_id": "Operator", "content": "@Dev A new one", "reply_to": sameAsID(first)})
	code, out = post(map[string]any{"subscriber_id": "Dev B", "content": "@Operator parser please?", "ask": true, "same_as": sameAsID(first)})
	assert.Equal(t, http.StatusBadRequest, code, "an answered ask is nothing to be the same as: %v", out)
}

// #17738: closing a goal resolves the open asks about it (closed, not answered) and tells their askers; asks about other goals are left.
func TestClosingAGoalRetiresItsAsksAndTellsTheAskers(t *testing.T) {
	h, bs, post := sameAsRig(t)
	ctx := context.Background()
	g, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship it", CreatedBy: "Operator"})
	require.NoError(t, err)
	_, q := post(map[string]any{"subscriber_id": "Dev A", "content": "@Operator ship it?", "ask": true, "ask_goal": g.ID})
	_, keep := post(map[string]any{"subscriber_id": "Dev B", "content": "@Operator unrelated?", "ask": true})

	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("project", "team")
	rctx.URLParams.Add("goalID", jsonInt(g.ID))
	req := httptest.NewRequest(http.MethodPost, "/api/board/team/goals/x/close", strings.NewReader(`{"reason":"shipped","subscriber_id":"Operator"}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.CloseGoal(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())

	_, rows, _ := readOperatorAsks(t, h, asPerson)
	open := map[int64]bool{}
	for _, r := range rows {
		open[int64(r["id"].(float64))] = true
	}
	assert.False(t, open[sameAsID(q)], "the goal's ask is resolved")
	assert.True(t, open[sameAsID(keep)], "another ask is left")
	m, err := bs.GetMessageByID(ctx, "team", sameAsID(q))
	require.NoError(t, err)
	assert.True(t, m.Ask.Closed)
	assert.Contains(t, m.Ask.ClosedNote, "goal #")
	msgs, err := bs.ListMessages(ctx, "team", 50, 0, 0)
	require.NoError(t, err)
	told := false
	for _, mm := range msgs {
		if strings.HasPrefix(mm.Content, "@Dev A") && strings.Contains(mm.Content, "closed, not answered") {
			told = true
		}
	}
	assert.True(t, told, "the asker is told")
}
