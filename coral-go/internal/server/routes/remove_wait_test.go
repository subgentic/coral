package routes

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/sessionstate"
)

// #14266 (QA's question on #14203): Dismiss keeps a wait that never clears (its evidence never came) listed in Needs you, still waiting. "Remove from Needs you" is the second, explicit action on such a row:
// POST dismiss-wait with remove:true. It marks the agent's CURRENT request removed (per agent and request): out of /api/needs-you and its count. It never resolves the wait, never releases held messages (the gate
// stays held while the prompt may be on screen) and types nothing; the agent's NEXT request shows again; only the owner may do it.

func (r *holdRig) removeWait(sessionID string, headers map[string]string) *httptest.ResponseRecorder {
	r.t.Helper()
	rt := chi.NewRouter()
	rt.Post("/api/sessions/live/{name}/dismiss-wait", r.h.DismissWait)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+r.name+"/dismiss-wait", bytes.NewBufferString(`{"session_id":"`+sessionID+`","agent_type":"claude","remove":true}`))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)
	return rec
}

func (r *holdRig) needsYouHas(sid string) (listed bool, flagged bool) {
	r.t.Helper()
	items, err := r.h.NeedsYouAgents(httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil))
	require.NoError(r.t, err)
	for _, it := range items {
		if it.ID == "agent:"+sid {
			return true, it.StillWaiting
		}
	}
	return false, false
}

func (r *holdRig) rowFlags(sid string) (ignored, removed, waiting bool) {
	r.t.Helper()
	rows, err := r.h.liveSessionRows(httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil), newPhaseTrace("test"), true)
	require.NoError(r.t, err)
	for _, row := range rows {
		if row["session_id"] == sid {
			ignored, _ = row["wait_ignored"].(bool)
			removed, _ = row["wait_removed"].(bool)
			waiting, _ = row["waiting_for_input"].(bool)
			return
		}
	}
	r.t.Fatalf("the agent %s is not on the live list", sid)
	return
}

func TestRemoveFromNeedsYouDropsADismissedWaitButKeepsTheAgentWaitingAndTheGateHeld(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.box("permission")
	require.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
	typedBefore, eventsBefore := len(r.typed()), r.eventCount()

	// not dismissed yet: there is nothing to remove, the Operator is told to Dismiss first, and nothing changes
	rec := r.removeWait(r.sid, nil)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	listed, _ := r.needsYouHas(r.sid)
	assert.True(t, listed, "still listed: it was refused")

	// dismissed: still listed, flagged; then removed: gone from the list and the count
	require.Equal(t, http.StatusOK, r.dismiss(r.sid).Code)
	listed, flagged := r.needsYouHas(r.sid)
	require.True(t, listed)
	require.True(t, flagged)
	rec = r.removeWait(r.sid, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"removed":true`)
	listed, _ = r.needsYouHas(r.sid)
	assert.False(t, listed, "removed: out of /api/needs-you and so out of its count")

	// the agent still waits, the gate is still held, nothing was written for it or typed into it
	ignored, removed, waiting := r.rowFlags(r.sid)
	assert.True(t, ignored)
	assert.True(t, removed, "the live row says it was removed")
	assert.True(t, waiting, "the agent still waits: the evidence has not come")
	assert.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
	assert.True(t, r.h.blockedOnBox(ctx, r.name, "claude", r.sid), "removing a row never releases held messages into a prompt")
	assert.Equal(t, typedBefore, len(r.typed()), "nothing was typed into the agent's terminal")
	assert.Equal(t, eventsBefore, r.eventCount(), "no event was recorded for the agent")

	// again, and a Dismiss of the same request after it: it stays removed
	require.Equal(t, http.StatusOK, r.removeWait(r.sid, nil).Code)
	require.Equal(t, http.StatusOK, r.dismiss(r.sid).Code)
	listed, _ = r.needsYouHas(r.sid)
	assert.False(t, listed, "a Dismiss of the request already removed does not bring it back")

	// the agent's own evidence clears it; its NEXT request shows again, not ignored and not removed
	r.answered()
	assert.False(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
	r.box("permission")
	require.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
	listed, flagged = r.needsYouHas(r.sid)
	assert.True(t, listed, "the next request is its own: it shows again")
	assert.False(t, flagged, "and it is not marked still waiting")
	ignored, removed, _ = r.rowFlags(r.sid)
	assert.False(t, ignored)
	assert.False(t, removed)
}

func TestRemoveFromNeedsYouIsTheOwnersAlone(t *testing.T) {
	resetOwnerState(t)
	r := newHoldRig(t, true)
	r.box("permission")
	require.Equal(t, http.StatusOK, r.dismiss(r.sid).Code)
	rec := r.removeWait(r.sid, granteeHeaders())
	assert.Equal(t, "owner_only", refusalCode(t, rec), "a Hub grantee may not remove it")
	listed, _ := r.needsYouHas(r.sid)
	assert.True(t, listed, "and nothing was removed")
	_, removed, _ := r.rowFlags(r.sid)
	assert.False(t, removed)
}

// A removal for an agent that has nothing to wait on changes nothing.
func TestRemoveFromNeedsYouWithNoWaitIsANoOp(t *testing.T) {
	r := newHoldRig(t, true)
	rec := r.removeWait(r.sid, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"dismissed":false`)
}

// Security's INFO 5 on #14266: a removed row is invisible in the count, so a new prompt must never stay hidden. A request is told from the next by when the agent raised it (WaitingSince), so the SAME request
// raised again (identical text, the same kind and tool) after the turn moved on, after it was answered, or after a stop, is a NEW ask and shows again. A second request that opens while the first is still open is the
// same wait (its start does not move) and stays removed; and a wait with no start time of the agent's own (Coral's held notice) cannot be removed at all.
func TestAnIdenticalRequestRaisedAgainAfterARemovalShowsAgain(t *testing.T) {
	for name, between := range map[string]func(r *holdRig){
		"it was answered":    func(r *holdRig) { r.answered() },
		"the turn stopped":   func(r *holdRig) { r.post(`{"event_type":"stop","summary":"Agent stopped"}`) },
		"a new prompt began": func(r *holdRig) { r.post(`{"event_type":"prompt_submit","summary":"The person typed"}`) },
	} {
		t.Run(name, func(t *testing.T) {
			r := newHoldRig(t, true)
			ctx := context.Background()
			r.requestFor("Wants to run: go test ./...")
			require.Equal(t, http.StatusOK, r.dismiss(r.sid).Code)
			require.Equal(t, http.StatusOK, r.removeWait(r.sid, nil).Code)
			listed, _ := r.needsYouHas(r.sid)
			require.False(t, listed)

			time.Sleep(3 * time.Millisecond) // the second ask is later than the first, as it is for real
			between(r)
			time.Sleep(3 * time.Millisecond)
			r.requestFor("Wants to run: go test ./...") // the very same request again
			require.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
			listed, flagged := r.needsYouHas(r.sid)
			assert.True(t, listed, "the same request raised again is a new ask: it shows in Needs you")
			assert.False(t, flagged, "and it is not marked still waiting")
			_, removed, _ := r.rowFlags(r.sid)
			assert.False(t, removed)
		})
	}

	t.Run("a second request while the first is still open is the same wait", func(t *testing.T) {
		r := newHoldRig(t, true)
		r.requestFor("Wants to run: ls")
		require.Equal(t, http.StatusOK, r.dismiss(r.sid).Code)
		require.Equal(t, http.StatusOK, r.removeWait(r.sid, nil).Code)
		time.Sleep(3 * time.Millisecond)
		r.requestFor("Wants to run: ls") // nothing answered in between: the start of the wait does not move
		listed, _ := r.needsYouHas(r.sid)
		assert.False(t, listed, "the request is still the open one: it stays removed")
	})
}

func TestACoralHeldNoticeWaitCannotBeRemoved(t *testing.T) {
	r := newHoldRig(t, true)
	r.post(fmt.Sprintf(`{"event_type":"notification","summary":%q}`, sessionstate.HeldInputSummary))
	st := r.h.deriveSingleSessionState(context.Background(), r.sid, 0)
	require.True(t, st.NeedsInput, "Coral's held notice is a wait")
	require.True(t, st.WaitingSince.IsZero(), "with no start time of the agent's own")
	require.Equal(t, http.StatusOK, r.dismiss(r.sid).Code)
	rec := r.removeWait(r.sid, nil)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	_, removed, _ := r.rowFlags(r.sid)
	assert.False(t, removed, "nothing was marked removed")
}
