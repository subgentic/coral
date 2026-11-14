package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

func TestDismissDialogKeepsOnlyTheSameEpisodeHidden(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	since := time.Now().Add(-20 * time.Minute).Truncate(time.Second)
	r.h.dialogs.observe(r.sid, promptScreen{}, true, since, 5, true)
	r.h.dialogs.observe(r.sid, promptScreen{}, true, since.Add(time.Second), 5, true)
	before := len(r.typed())
	rt := chi.NewRouter()
	rt.Post("/api/sessions/live/{name}/dismiss-wait", r.h.DismissWait)
	post := func(at string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"session_id": r.sid, "agent_type": "claude", "dialog_since": at})
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+r.name+"/dismiss-wait", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, req)
		return rec
	}
	rec := post(since.UTC().Format(time.RFC3339))
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"dismissed":true`)
	keys, err := r.h.ss.WaitIgnoredKeys(ctx)
	require.NoError(t, err)
	require.Equal(t, "dialog:"+since.UTC().Format(time.RFC3339), keys[r.sid], "persistent, episode-scoped record")
	field := func() map[string]any {
		rec := httptest.NewRecorder()
		r.h.List(rec, httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil))
		var rows []map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))
		for _, row := range rows {
			if row["session_id"] == r.sid {
				d, _ := row["at_dialog"].(map[string]any)
				return d
			}
		}
		t.Fatal("agent absent from live list")
		return nil
	}
	require.Equal(t, true, field()["dismissed"], "another browser receives the stored dismissal")
	r.h.dialogs.forget(r.sid)
	next := since.Add(time.Minute)
	r.h.dialogs.observe(r.sid, promptScreen{}, true, next, 5, true)
	r.h.dialogs.observe(r.sid, promptScreen{}, true, next.Add(time.Second), 5, true)
	require.NotEqual(t, true, field()["dismissed"], "a new episode is visible")
	rec = post(since.UTC().Format(time.RFC3339))
	require.Equal(t, 200, rec.Code)
	require.Contains(t, rec.Body.String(), `"dismissed":false`, "a stale button cannot dismiss the new episode")
	require.Equal(t, before, len(r.typed()), "nothing is typed into the terminal")
}
