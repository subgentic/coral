package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

func TestChiefPersonCannotReportAgentStates(t *testing.T) {
	for _, state := range []string{"routed", "waiting_on_operator"} {
		t.Run(state, func(t *testing.T) {
			_, h, check := chiefTestCheck(t, false)
			ctx := context.Background()
			trigger, err := h.sched.BeginChiefTrigger(ctx, check.ID, 0, "", time.Now())
			require.NoError(t, err)
			before, err := h.sched.ChiefTrigger(ctx, trigger.ID)
			require.NoError(t, err)

			req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/chief/triggers/%d/state", trigger.ID), strings.NewReader(fmt.Sprintf(`{"state":%q}`, state)))
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
			router := chi.NewRouter()
			h.Register(router)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)

			require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), "the person may only resolve or reopen a trigger")
			after, err := h.sched.ChiefTrigger(ctx, trigger.ID)
			require.NoError(t, err)
			require.Equal(t, before, after, "a rejected person request must leave the trigger untouched")
		})
	}
}

func TestChiefPersonReopenConflictsWithExistingOpenTrigger(t *testing.T) {
	_, h, check := chiefTestCheck(t, false)
	ctx := context.Background()
	resolved, err := h.sched.BeginChiefTrigger(ctx, check.ID, 0, "", time.Now())
	require.NoError(t, err)
	require.NoError(t, h.sched.SetChiefTriggerResolution(ctx, resolved.ID, "done", time.Now()))
	open, err := h.sched.BeginChiefTrigger(ctx, check.ID, 0, "", time.Now())
	require.NoError(t, err)
	beforeResolved, err := h.sched.ChiefTrigger(ctx, resolved.ID)
	require.NoError(t, err)
	beforeOpen, err := h.sched.ChiefTrigger(ctx, open.ID)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/chief/triggers/%d/state", resolved.ID), strings.NewReader(`{"state":"open"}`))
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	router := chi.NewRouter()
	h.Register(router)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)

	require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), `"code":"trigger_conflict"`)
	afterResolved, err := h.sched.ChiefTrigger(ctx, resolved.ID)
	require.NoError(t, err)
	require.Equal(t, beforeResolved, afterResolved, "failed reopen must preserve the resolved trigger")
	afterOpen, err := h.sched.ChiefTrigger(ctx, open.ID)
	require.NoError(t, err)
	require.Equal(t, beforeOpen, afterOpen, "failed reopen must preserve the competing trigger")
}
