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
)

// #15304 (walk 18 H2): "Done, please check" in a plain @Operator post is no row in Needs you; the sender is told in the post's own answer, not ten minutes later by the board's check.
func TestAPostThatWaitsOnTheOperatorWithoutAskTellsItsSender(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	for _, who := range []string{"Lead", "Operator"} {
		_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	post := func(from, content string, ask bool) map[string]any {
		b, _ := json.Marshal(map[string]any{"subscriber_id": from, "content": content, "ask": ask})
		req := httptest.NewRequest(http.MethodPost, "/api/board/team/messages", strings.NewReader(string(b)))
		req.Header.Set("Content-Type", "application/json")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		h.PostMessage(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	out := post("Lead", "@Operator goal 1 is done, please check index.html", false)
	assert.Contains(t, out["not_in_needs_you"], "--ask", "a plain @Operator post is told it is not in Needs you")
	assert.Nil(t, post("Lead", "@Operator is goal 1 done?", true)["not_in_needs_you"], "an --ask is a row: nothing to say")
	assert.Nil(t, post("Lead", "status: tests green, nothing for anyone", false)["not_in_needs_you"], "a post that waits on no one is not told")
	assert.Nil(t, post("Lead", "@Operator report is coral://artifacts/"+strings.Repeat("a", 64), false)["not_in_needs_you"], "a post that links a file (maybe tagged for review) is left to the board's check")
	assert.Nil(t, post("Operator", "@Lead go ahead, your call", false)["not_in_needs_you"], "the Operator's own post is never told")
}
