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
)

// #13883: Dismiss (Ignore) of a question through a cloud Hub answered 403 not_allowed at v2.0.56. The close route is an owner route of the tunnel table, and TunnelIdentityGuard lets every POST on an owner
// route pass without making the request the Operator's (isHubSwitchRoute), so the actor the identity layer gave CloseAsk was the Hub user's label, which is neither the asker, the Operator nor an
// orchestrator. board_ask_close_hub_test.go built the Operator actor by hand, which is what the guard would have made, and so never ran the guard. This test runs the real guard and the identity layer's own
// actor choice (actorFor) in front of the real handler.

// viaGuard serves one close call through TunnelIdentityGuard, the identity layer's actor choice for a Hub request and CloseAsk.
func viaGuard(t *testing.T, h *BoardHandler, qid int64, hdr map[string]string, body map[string]any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	handler := TunnelIdentityGuard(h.bs, func(*http.Request) bool { return true })(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor, ok := actorFor(r, callerHub)
		require.True(t, ok)
		r = withActor(r, actor)
		r = r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerHub))
		h.CloseAsk(w, r)
	}))
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/board/team/asks/%d/close", qid), strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rc := chi.NewRouteContext()
	rc.URLParams.Add("project", "team")
	rc.URLParams.Add("messageID", fmt.Sprint(qid))
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestTheOwnersIgnoreAndUndoWorkThroughTheRealGuard(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "team", "Lead", "Lead Developer", "", nil, "all")
	require.NoError(t, err)
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator may I proceed?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	open := func() int { _, rows, _ := readOperatorAsks(t, h, asPerson); return len(rows) }
	require.Equal(t, 1, open())

	// a grantee gets owner_only and nothing changes
	code, out := viaGuard(t, h, q.ID, granteeHeaders(), map[string]any{"note": "Dismissed by the operator"})
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "owner_only", out["code"])
	assert.Equal(t, 1, open())

	// the owner's Ignore: closed by the Operator, not refused as not_allowed
	code, out = viaGuard(t, h, q.ID, ownerHeaders(ownerLabel), map[string]any{"note": "Dismissed by the operator"})
	require.Equal(t, http.StatusOK, code, "the owner's Ignore through the Hub must work (answer: %v)", out)
	assert.Equal(t, "Operator", out["closed_by"], "the close is the Operator's, not the Hub user's label")
	assert.Equal(t, 0, open())
	acts, err := bs.RecentHubOperatorActions(ctx, 10)
	require.NoError(t, err)
	require.Len(t, acts, 1, "the Hub's use of the Operator is recorded, as pause and resume are")
	assert.Equal(t, ownerLabel, acts[0].HubUser)
	assert.Equal(t, "/api/board/team/asks/"+fmt.Sprint(q.ID)+"/close", acts[0].Path)

	// and the owner's Undo
	code, out = viaGuard(t, h, q.ID, ownerHeaders(ownerLabel), map[string]any{"undo": true})
	require.Equal(t, http.StatusOK, code, "answer: %v", out)
	assert.Equal(t, 1, open())

	// the Hub user's label is still not an asker or an orchestrator for anything else: an owner may not withdraw (that is the asker's)
	code, out = viaGuard(t, h, q.ID, ownerHeaders(ownerLabel), map[string]any{"withdraw": true, "note": "x"})
	assert.Equal(t, http.StatusForbidden, code, "the Operator ignores a question; only the asker withdraws it (answer: %v)", out)
	assert.Equal(t, 1, open())
}
