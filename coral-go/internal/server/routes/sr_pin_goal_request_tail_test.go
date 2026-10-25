package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// Pins the exact tail of acrossBoards: another team's Orchestrator who has the SAME NAME as the target's Orchestrator must not answer (accept or decline) a request on the target board.
func TestSRPinAnotherTeamsSameNamedOrchestratorCannotAnswer(t *testing.T) {
	_, bh := setupBoardTestServer(t)
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	defer db.Close()
	sub := func(b, id, role, sess string) {
		_, err := bh.bs.Subscribe(ctx, b, id, role, sess, nil, "all")
		require.NoError(t, err)
	}
	sub("alpha", "Orchestrator", "Orchestrator", "claude-orch-a")
	sub("beta", "Orchestrator", "Orchestrator", "claude-orch-b") // the same name on the target team
	on := true
	for _, b := range []string{"alpha", "beta"} {
		_, err = bh.bs.UpdateBoardSettings(ctx, b, board.BoardSettingsUpdate{CrossTeamMessaging: &on, GoalRequests: &on})
		require.NoError(t, err)
	}
	g, err := bh.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "A goal", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	_, in, err := bh.bs.SendGoalRequest(ctx, "alpha", g.ID, "beta", "build it", "Orchestrator", nil)
	require.NoError(t, err)
	tokA, err := db.MintSessionToken(ctx, "sid-a", "claude-orch-a")
	require.NoError(t, err)
	o := NewIdentityObserver(db, bh.bs, func(*http.Request) bool { return false })
	o.SetStrict()
	r := chi.NewRouter()
	r.Use(o.Middleware)
	r.Post("/api/board/{project}/goal-requests/{requestID}/accept", bh.AcceptGoalRequest)
	r.Post("/api/board/{project}/goal-requests/{requestID}/decline", bh.DeclineGoalRequest)
	for _, p := range []struct{ path, body string }{
		{"accept", `{"subscriber_id":"Orchestrator","title":"mine"}`},
		{"decline", `{"subscriber_id":"Orchestrator","reason":"no"}`},
	} {
		req := httptest.NewRequest("POST", "/api/board/beta/goal-requests/"+itoa(in.ID)+"/"+p.path, strings.NewReader(p.body))
		req.Header.Set(store.SessionTokenHeader, tokA)
		req.Header.Set("User-Agent", "coral-board/dev")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		require.Equal(t, http.StatusForbidden, rec.Code, p.path+": "+rec.Body.String())
	}
	got, err := bh.bs.GetGoalRequestIn(ctx, "beta", in.ID)
	require.NoError(t, err)
	require.Equal(t, board.GoalRequestPending, got.Status)
}
