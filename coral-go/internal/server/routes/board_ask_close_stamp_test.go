package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// Ignore and Undo through our own hub (#13462, found while building #13450): a close that reaches this computer with the hub's API key and NO stamp closes the question but is not the person's own Ignore (no Activity
// row, no Inbox number) and its Undo is refused; the same request carrying the hub's genuine owner stamp (callerHubOwner) is the person's: recorded, counted, and undone.
func TestIgnoreAndUndoThroughOurOwnHubAreThePersonsOnlyWhenStamped(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "team", "Lead", "Lead Developer", "", nil, "all")
	require.NoError(t, err)
	post := func(text string) *board.Message {
		q, err := bs.PostMessage(ctx, "team", "Lead", text, nil)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
		return q
	}
	call := func(q *board.Message, kind string, body map[string]any) int {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/board/team/asks/%d/close", q.ID), strings.NewReader(string(raw)))
		req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind))
		rc := chi.NewRouteContext()
		rc.URLParams.Add("project", "team")
		rc.URLParams.Add("messageID", fmt.Sprint(q.ID))
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
		w := httptest.NewRecorder()
		h.CloseAsk(w, req)
		return w.Code
	}
	ignores := func() int {
		rows, err := bs.ListActivity(ctx, board.ActivityFilter{Action: board.ActIgnore, Limit: 50})
		require.NoError(t, err)
		return len(rows)
	}
	open := func() int { _, rows, _ := readOperatorAsks(t, h, asPerson); return len(rows) }

	// an API key with no stamp: it closes, it is not the person's own Ignore, and it cannot undo
	q1 := post("@Operator first?")
	require.Equal(t, http.StatusOK, call(q1, callerAPIKey, map[string]any{"note": "Dismissed by the operator"}))
	assert.Equal(t, 0, ignores(), "no Activity row for a close nobody proved a person made")
	assert.Equal(t, http.StatusForbidden, call(q1, callerAPIKey, map[string]any{"undo": true}), "an unstamped Undo is refused")

	// the hub's genuine stamp: the person's own Ignore, recorded, and its Undo works
	q2 := post("@Operator second?")
	before := open()
	require.Equal(t, http.StatusOK, call(q2, callerHubOwner, map[string]any{"note": "Dismissed by the operator"}))
	assert.Equal(t, 1, ignores(), "the person's Ignore is in Activity")
	assert.Equal(t, before-1, open())
	require.Equal(t, http.StatusOK, call(q2, callerHubOwner, map[string]any{"undo": true}), "the person undoes it")
	assert.Equal(t, before, open())
}
