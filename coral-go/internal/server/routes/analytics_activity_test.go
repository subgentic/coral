package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

// #11225: the same read carries the Operator's touches and the messages per task, as counts: no message text, no typed text, no length.
func TestActivityRouteCarriesTouchesAndTaskMessagesAsCountsOnly(t *testing.T) {
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "team", "Dev", "Dev", "claude-dev", nil, "all")
	require.NoError(t, err)
	task, err := bs.CreateTask(ctx, "team", "build", "", "medium", "Operator", "Dev")
	require.NoError(t, err)
	require.NoError(t, bs.RecordOperatorTouch(ctx, "team", "Dev", board.TouchTyped, time.Now()))
	require.NoError(t, bs.RecordOperatorTouch(ctx, "team", "Dev", board.TouchStop, time.Now()))
	_, err = bs.PostMessage(ctx, "team", "Dev", "SECRET-WORDS @Operator", nil)
	require.NoError(t, err)
	h := NewActivityHandler(bs)

	code, body := activityGet(t, h, "team=team&range=7d")
	require.Equal(t, http.StatusOK, code)
	var out struct {
		Activity struct {
			Touches *struct {
				Kinds  map[string]int   `json:"kinds"`
				Days   []map[string]any `json:"days"`
				Agents []map[string]any `json:"agents"`
			} `json:"touches"`
			TaskMessages []map[string]any `json:"task_messages"`
		} `json:"activity"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	require.NotNil(t, out.Activity.Touches, "the touches are in the read")
	require.Equal(t, 1, out.Activity.Touches.Kinds["typed"])
	require.Equal(t, 1, out.Activity.Touches.Kinds["stop"])
	require.Equal(t, "Dev", out.Activity.Touches.Agents[0]["name"])
	require.NotNil(t, out.Activity.TaskMessages, "task_messages is a list (empty when no task was in progress)")
	require.False(t, strings.Contains(body, "SECRET-WORDS"), "the reply carries counts, never text")
	_ = task
}
