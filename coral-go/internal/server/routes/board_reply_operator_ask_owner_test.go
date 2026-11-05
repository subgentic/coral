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

// Through Coral Hub, answering a question put to the Operator is the owner's alone (#13491): a reply_to that targets an ask addressed to the Operator is refused 403 owner_only for a grantee, whoever
// they are; the owner and this computer are served; a plain post, or a reply to a question put to somebody else, is as it always was.
func TestAReplyToAnAskPutToTheOperatorIsTheHubOwnersAlone(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	_, err := h.bs.Subscribe(ctx, "team", "Dev", "Developer", "", nil, "all")
	require.NoError(t, err)
	withLabel(t, ownerLabel, nil)

	toOperator, err := h.bs.PostMessage(ctx, "team", "Orchestrator", "Which do you want? @Operator", nil)
	require.NoError(t, err)
	require.NoError(t, h.bs.RecordAsk(ctx, "team", toOperator, []string{"Operator"}))
	toDev, err := h.bs.PostMessage(ctx, "team", "Orchestrator", "Can you take it? @Dev", nil)
	require.NoError(t, err)
	require.NoError(t, h.bs.RecordAsk(ctx, "team", toDev, []string{"Dev"}))
	plain, err := h.bs.PostMessage(ctx, "team", "Orchestrator", "Just an update", nil)
	require.NoError(t, err)

	post := func(hdr map[string]string, replyTo int64) (int, map[string]any) {
		body := `{"subscriber_id":"Operator","content":"my answer"`
		if replyTo != 0 {
			body += `,"reply_to":` + itoa(replyTo)
		}
		body += `}`
		req := httptest.NewRequest(http.MethodPost, "/api/board/team/messages", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		h.PostMessage(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	code, out := post(granteeHeaders(), toOperator.ID)
	assert.Equal(t, http.StatusForbidden, code, "a grantee cannot answer the Operator's question: %v", out)
	assert.Equal(t, "owner_only", out["code"])
	code, _ = post(map[string]string{}, toOperator.ID)
	assert.Less(t, code, 300, "this computer's own caller is served, as before")
	code, out = post(ownerHeaders(ownerLabel), toOperator.ID)
	assert.Less(t, code, 300, "the hub's owner is served: %v", out)

	for name, replyTo := range map[string]int64{"a plain post": 0, "a reply to a message that is no ask": plain.ID, "a reply to a question put to another member": toDev.ID} {
		code, out = post(granteeHeaders(), replyTo)
		assert.Less(t, code, 300, "%s is as it always was: %v", name, out)
	}
}

// A guide is no owner either: an answer to a question put to the Operator is refused 403 owner_only (not the 400 for a reply_to that is not one of theirs); a reply to a question put to the guide is as before.
func TestAGuideCannotAnswerAnAskPutToTheOperator(t *testing.T) {
	g := newGuideRig(t)
	ctx := context.Background()
	_, err := g.bs.Subscribe(ctx, gBoard, "Orchestrator", "Orchestrator", "", nil, "all")
	require.NoError(t, err)
	toOperator, err := g.bs.PostMessage(ctx, gBoard, "Orchestrator", "Which do you want? @Operator", nil)
	require.NoError(t, err)
	require.NoError(t, g.bs.RecordAsk(ctx, gBoard, toOperator, []string{"Operator"}))
	code, out, raw := g.guide(gDana, now(), "POST", "/api/board/team/messages", map[string]any{"content": "I answer for the Operator", "reply_to": toOperator.ID}, nil)
	assert.Equal(t, http.StatusForbidden, code, raw)
	assert.Equal(t, "owner_only", out["code"])
}

// A lookup that fails for a request that could be refused is a 500, never let through (Security's SHOULD on #13491); a reply_to that is no message of the board is the 400 it always was.
func TestAFailedLookupOfWhatAReplyAnswersStopsTheRequestAndNotFoundKeepsItsRefusal(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	toOperator, err := h.bs.PostMessage(ctx, "team", "Orchestrator", "Which do you want? @Operator", nil)
	require.NoError(t, err)
	require.NoError(t, h.bs.RecordAsk(ctx, "team", toOperator, []string{"Operator"}))
	post := func(replyTo int64) int {
		req := httptest.NewRequest(http.MethodPost, "/api/board/team/messages", strings.NewReader(`{"subscriber_id":"Operator","content":"my answer","reply_to":`+itoa(replyTo)+`}`))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range granteeHeaders() {
			req.Header.Set(k, v)
		}
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "team")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		h.PostMessage(rec, req)
		return rec.Code
	}
	assert.Equal(t, http.StatusBadRequest, post(99999), "a message that is not on this board keeps its 400")
	require.NoError(t, h.bs.Close())
	assert.Equal(t, http.StatusInternalServerError, post(toOperator.ID), "a failed lookup stops a request that could be refused")
}
