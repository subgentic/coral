package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Through the routes: naming the reserved key as a board makes none (a message, a subscription) and answers a 4xx, never a 500 (#13527).
func TestTheRoutesRefuseABoardKeyThatStartsWithATilde(t *testing.T) {
	_, h := setupBoardTestServer(t)
	call := func(handler http.HandlerFunc, path, body string) int {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "~no-team")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		handler(rec, req)
		return rec.Code
	}
	code := call(h.PostMessage, "/api/board/~no-team/messages", `{"subscriber_id":"Operator","content":"hello"}`)
	assert.GreaterOrEqual(t, code, 400, "a message to the reserved key is refused")
	assert.Less(t, code, 500, "and is not a server error: %d", code)
	known, err := h.bs.BoardKnown(context.Background(), "~no-team")
	require.NoError(t, err)
	assert.False(t, known, "no board of that key was made")
}
