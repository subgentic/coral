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

func TestChiefStateStoreFailuresAreInternalErrors(t *testing.T) {
	for _, agent := range []bool{false, true} {
		for _, failure := range []string{"update abort", "closed database"} {
			t.Run(fmt.Sprintf("agent=%v/%s", agent, failure), func(t *testing.T) {
				rig, h, c := chiefTestCheck(t, false)
				ctx := context.Background()
				tr, err := h.sched.BeginChiefTrigger(ctx, c.ID, 0, "", time.Now())
				require.NoError(t, err)
				require.NoError(t, h.sched.UpdateChiefTriggerState(ctx, tr.ID, "open", "Prior report", 0, 0, 0, time.Now()))
				h.now = func() time.Time {
					if failure == "closed database" {
						require.NoError(t, rig.h.db.Close())
					} else {
						_, err = rig.h.db.ExecContext(ctx, `CREATE TRIGGER chief_state_failure BEFORE UPDATE ON chief_triggers BEGIN SELECT RAISE(ABORT, 'private injected database failure'); END`)
						require.NoError(t, err)
					}
					return time.Now()
				}
				req := httptest.NewRequest("POST", fmt.Sprintf("/api/chief/triggers/%d/state", tr.ID), strings.NewReader(`{"state":"done"}`))
				if agent {
					req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sendSid(1)}))
				} else {
					req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
				}
				r := chi.NewRouter()
				h.Register(r)
				w := httptest.NewRecorder()
				r.ServeHTTP(w, req)
				require.Equal(t, 500, w.Code, w.Body.String())
				require.NotContains(t, w.Body.String(), "trigger_conflict")
				require.NotContains(t, w.Body.String(), "private injected")
				if failure == "update abort" {
					saved, err := h.sched.ChiefTrigger(ctx, tr.ID)
					require.NoError(t, err)
					require.Equal(t, "open", saved.State)
					require.Equal(t, "Prior report", saved.Summary)
				}
			})
		}
	}
}
