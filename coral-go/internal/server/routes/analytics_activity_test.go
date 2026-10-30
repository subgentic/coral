package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

func activityGet(t *testing.T, h *ActivityHandler, query string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Activity(rec, httptest.NewRequest(http.MethodGet, "/api/analytics/activity?"+query, nil))
	return rec.Code, rec.Body.String()
}

func TestActivityRouteBoundsAndReturnsCountsOnly(t *testing.T) {
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", "Orchestrator", nil, "all")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "team", "Orchestrator", "PRIVATE-TEXT @Operator", nil)
	require.NoError(t, err)
	h := NewActivityHandler(bs)

	code, body := activityGet(t, h, "team=team&range=7d")
	require.Equal(t, http.StatusOK, code)
	require.Contains(t, body, `"agent_posts":1`)
	require.False(t, strings.Contains(body, "PRIVATE-TEXT"), "the reply carries counts, never text")

	for _, q := range []string{"range=7d", "team=team&range=1y", "team=team&range=7d%20", "team=%20&range=7d"} {
		code, _ := activityGet(t, h, q)
		require.Equal(t, http.StatusBadRequest, code, q)
	}
	code, _ = activityGet(t, h, "team=team")
	require.Equal(t, http.StatusOK, code, "the range defaults to 14 days")
}
