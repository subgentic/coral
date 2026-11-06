package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13947 (Developer experience's isolated run on #13943): an agent waiting for the Operator's decision on its file did not wake on a denial, and a wait --from Operator woke on no decision. The notice of a decision is the
// Operator's message to the agent, so it ends the waits that match it, as every other message the Operator posts does.
func reviewWaitRig(t *testing.T, decision, aliceWaitsFor string) (done func() map[string]string) {
	t.Helper()
	_, h, coralDir := teamArtifactServer(t)
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	subscribeSession(t, h, "alpha", "Bob", sessBob)
	id := storeManagedArtifact(t, coralDir, "# the plan "+decision, true, true)
	completeWithArtifactsAs(t, h, "alpha", "Alice", "A work", []board.TaskArtifact{{Name: "plan.md", URI: "coral://artifacts/" + id}})
	_, err := h.bs.AddArtifactTags(context.Background(), "alpha", id, []string{"for review"})
	require.NoError(t, err)
	ctx := context.Background()
	// Alice waits for a message (of anyone, or from the Operator); Bob has nothing to do with the file and waits from the Operator: a notice addressed to Alice is not a reply to Bob
	_, err = h.bs.RegisterWait(ctx, "alpha", "Alice", "", "message", aliceWaitsFor, "waiting for the review", time.Hour)
	require.NoError(t, err)
	_, err = h.bs.RegisterWait(ctx, "alpha", "Bob", "", "message", "Operator", "waiting for the Operator", time.Hour)
	require.NoError(t, err)
	r := chi.NewRouter()
	r.Post("/api/board/{project}/artifacts/{id}/review", func(w http.ResponseWriter, req *http.Request) {
		h.ReviewArtifact(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie)))
	})
	req := httptest.NewRequest(http.MethodPost, "/api/board/alpha/artifacts/"+id+"/review", strings.NewReader(`{"decision":"`+decision+`","reason":"not this one"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	h.WaitBackground()
	return func() map[string]string {
		out := map[string]string{}
		waits, err := h.bs.ListActiveWaits(ctx, "alpha")
		require.NoError(t, err)
		active := map[string]bool{}
		for _, w := range waits {
			active[w.SubscriberID] = true
		}
		for _, who := range []string{"Alice", "Bob"} {
			if active[who] {
				out[who] = "waiting"
			} else {
				out[who] = "woken"
			}
		}
		return out
	}
}

func TestADenialWakesTheAgentWaitingOnItsFileOnAPlainWaitAndOnAWaitFromTheOperator(t *testing.T) {
	for name, target := range map[string]string{"a plain wait": "", "a wait from the Operator": "Operator"} {
		state := reviewWaitRig(t, "deny", target)()
		assert.Equal(t, "woken", state["Alice"], name)
		assert.Equal(t, "waiting", state["Bob"], name+": a notice addressed to Alice is not a reply to Bob's wait")
	}
}

func TestAnApprovalWakesTheAgentWaitingOnItsFileOnAPlainWaitAndOnAWaitFromTheOperator(t *testing.T) {
	for name, target := range map[string]string{"a plain wait": "", "a wait from the Operator": "Operator"} {
		state := reviewWaitRig(t, "approve", target)()
		assert.Equal(t, "woken", state["Alice"], name)
		assert.Equal(t, "waiting", state["Bob"], name)
	}
}
