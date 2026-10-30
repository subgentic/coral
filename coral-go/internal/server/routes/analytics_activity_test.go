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

	"github.com/go-chi/chi/v5"
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
	require.NoError(t, bs.RecordOperatorTouch(ctx, "team", "Dev", board.TouchTyped, board.TouchLocal, time.Now()))
	require.NoError(t, bs.RecordOperatorTouch(ctx, "team", "Dev", board.TouchStop, board.TouchHub, time.Now()))
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

// #11225 (Security's MUST): through Coral Hub the activity counts are the owner's alone: a grantee at Launch or below, an owner from another account and an unlabelled caller get 403 owner_only; the
// owner and this computer's own dashboard read it.
func TestActivityThroughTheHubIsOwnerOnly(t *testing.T) {
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "team", "Dev", "Dev", "claude-dev", nil, "all")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "team", "Dev", "PRIVATE-TEXT", nil)
	require.NoError(t, err)
	r := chi.NewRouter()
	r.Get("/api/analytics/activity", NewActivityHandler(bs).Activity)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	for _, c := range hubCallers() {
		withLabel(t, c.label, nil)
		status, body := hubGet(t, srv.URL+"/api/analytics/activity?team=team&range=7d", c.header)
		if c.allow {
			require.Equal(t, http.StatusOK, status, c.name+": "+body)
			continue
		}
		require.Equal(t, http.StatusForbidden, status, c.name)
		if strings.Contains(c.name, "no enrolled label") {
			require.Contains(t, body, "owner_label_missing", c.name) // the owner of a machine that recorded no owner at enrolment: asked to confirm it, not told they are not the owner
		} else {
			require.Contains(t, body, "owner_only", c.name)
			require.Contains(t, body, "the account this computer is linked to only", c.name)
		}
		require.NotContains(t, body, "agent_posts", c.name+": a refusal carries no counts")
	}
	// this computer's own request (not through the Hub) is as before
	withLabel(t, ownerLabel, nil)
	status, _ := hubGet(t, srv.URL+"/api/analytics/activity?team=team&range=7d", nil)
	require.Equal(t, http.StatusOK, status)
}

// Security's #11225 SHOULD 1: the messages are scanned once for an hour-aligned window however many reads ask for it (a polling tab, two tabs); the next hour, another team or another range is another
// scan; and the touches, a cheap read, are fresh on every read.
func TestActivityReadsScanTheMessagesOncePerHour(t *testing.T) {
	bs, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "team", "Dev", "Dev", "claude-dev", nil, "all")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "team", "Dev", "a post", nil)
	require.NoError(t, err)
	h := NewActivityHandler(bs)
	clock := time.Date(2026, 10, 30, 9, 10, 0, 0, time.UTC)
	h.now = func() time.Time { return clock }

	for i := 0; i < 5; i++ {
		code, _ := activityGet(t, h, "team=team&range=7d")
		require.Equal(t, http.StatusOK, code)
	}
	require.EqualValues(t, 1, h.scans.Load(), "five reads in the hour scanned the messages once")
	clock = clock.Add(20 * time.Minute)
	activityGet(t, h, "team=team&range=7d")
	require.EqualValues(t, 1, h.scans.Load(), "still the same hour")

	// a touch made after the first read shows on the next one
	require.NoError(t, bs.RecordOperatorTouch(ctx, "team", "Dev", board.TouchStop, board.TouchLocal, clock))
	_, body := activityGet(t, h, "team=team&range=7d")
	require.Contains(t, body, `"stop":1`, "the touches are not cached")
	require.EqualValues(t, 1, h.scans.Load())

	activityGet(t, h, "team=team&range=30d")
	require.EqualValues(t, 2, h.scans.Load(), "another range")
	activityGet(t, h, "team=other&range=7d")
	require.EqualValues(t, 3, h.scans.Load(), "another team")
	clock = clock.Add(time.Hour)
	activityGet(t, h, "team=team&range=7d")
	require.EqualValues(t, 4, h.scans.Load(), "the next hour")
}
