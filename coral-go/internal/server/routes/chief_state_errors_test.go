package routes

import (
	"context"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestChiefStateUpdateDistinguishesMissingFromConflict(t *testing.T) {
	for _, agent := range []bool{false, true} {
		for _, missing := range []bool{true, false} {
			t.Run(fmt.Sprintf("agent=%v/missing=%v", agent, missing), func(t *testing.T) {
				rig, h, c := chiefTestCheck(t, false)
				ctx := context.Background()
				tr, err := h.sched.BeginChiefTrigger(ctx, c.ID, 0, "", time.Now())
				require.NoError(t, err)
				require.NoError(t, h.sched.UpdateChiefTriggerState(ctx, tr.ID, "done", "Result", 0, 0, 0, time.Now()))
				// Deterministic interleaving after handler lookup, immediately before UPDATE.
				h.now = func() time.Time {
					if missing {
						_, err = rig.h.db.ExecContext(ctx, `DELETE FROM chief_triggers WHERE id=?`, tr.ID)
					} else {
						_, err = h.sched.BeginChiefTrigger(ctx, c.ID, 0, "", time.Now())
					}
					require.NoError(t, err)
					return time.Now()
				}
				req := httptest.NewRequest("POST", fmt.Sprintf("/api/chief/triggers/%d/state", tr.ID), strings.NewReader(`{"state":"open"}`))
				if agent {
					req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sendSid(1)}))
				} else {
					req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
				}
				router := chi.NewRouter()
				h.Register(router)
				w := httptest.NewRecorder()
				router.ServeHTTP(w, req)
				if missing {
					require.Equal(t, 404, w.Code, w.Body.String())
					require.NotContains(t, w.Body.String(), "another trigger is already open")
				} else {
					require.Equal(t, 409, w.Code, w.Body.String())
					require.Contains(t, w.Body.String(), "trigger_conflict")
				}
			})
		}
	}
}
