package routes

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/sessionstate"
)

// #12694 (the Operator: in auto mode "some things are making it to my inbox before auto-mode acts"): a permission request of a Claude agent in auto mode is held back from what waits for the Operator until
// auto mode has had its chance; a default-mode agent's shows at once; a question or a plan is Claude asking the person and shows at once in any mode.
func TestHeldForAutoModeIsOnlyAnAutoModePermissionRequestInsideTheGrace(t *testing.T) {
	now := time.Now()
	open := func(kind string, age time.Duration) sessionstate.State {
		return sessionstate.State{NeedsInput: true, OwnRequest: true, WaitingKind: kind, WaitingSince: now.Add(-age)}
	}
	grace := 8 * time.Second
	for name, c := range map[string]struct {
		mode any
		st   sessionstate.State
		want bool
	}{
		"auto, a permission, just opened":    {"auto", open("permission", time.Second), true},
		"auto, a permission, still inside":   {"auto", open("permission", 7*time.Second), true},
		"auto, a permission, past the grace": {"auto", open("permission", 9*time.Second), false},
		"auto, exactly at the grace":         {"auto", open("permission", grace), false},
		"default mode shows at once":         {"default", open("permission", time.Second), false},
		"accept edits shows at once":         {"acceptEdits", open("permission", time.Second), false},
		"plan mode shows at once":            {"plan", open("permission", time.Second), false},
		"bypass shows at once":               {"bypassPermissions", open("permission", time.Second), false},
		"no mode known shows at once":        {nil, open("permission", time.Second), false},
		"auto, a question to the person":     {"auto", open("question", time.Second), false},
		"auto, a plan to approve":            {"auto", open("plan", time.Second), false},
		"auto, an elicitation":               {"auto", open("elicitation", time.Second), false},
		"auto, no kind said":                 {"auto", open("", time.Second), false},
		"auto, Coral's own held notice":      {"auto", sessionstate.State{NeedsInput: true, OwnRequest: false, WaitingKind: "permission", WaitingSince: now}, false},
		"auto, nothing is waiting":           {"auto", sessionstate.State{}, false},
		"auto, a request with no start time": {"auto", sessionstate.State{NeedsInput: true, OwnRequest: true, WaitingKind: "permission"}, false},
	} {
		assert.Equal(t, c.want, heldForAutoMode(c.mode, c.st, now, grace), name)
	}
	assert.False(t, heldForAutoMode("auto", open("permission", time.Second), now, 0), "a grace of 0 holds nothing")
}

// Through the live rows, with an agent's own hook events: an auto-mode agent's prompt that resolves within the grace never reaches the row; one still open after it does; a default-mode agent's shows at once.
func TestTheLiveRowHoldsAnAutoModePermissionRequestUntilTheGraceIsOver(t *testing.T) {
	prev := autoModeGraceMs.Load()
	t.Cleanup(func() { autoModeGraceMs.Store(prev) })
	row := func(r *holdRig) map[string]any {
		t.Helper()
		rows, err := r.h.liveSessionRows(httptest.NewRequest("GET", "/api/sessions/live", nil), newPhaseTrace("test"), false)
		require.NoError(t, err)
		for _, x := range rows {
			if x["session_id"] == r.sid {
				return x
			}
		}
		t.Fatal("the agent is not in the live rows")
		return nil
	}
	mode := func(r *holdRig, m string) {
		r.post(`{"event_type":"prompt_submit","summary":"User submitted prompt","permission_mode":"` + m + `"}`)
	}

	// auto mode, the grace long: the request is on the events and not in the row (nor in what waits for the Operator), and when it resolves the row never showed it
	autoModeGraceMs.Store(int64(time.Hour / time.Millisecond))
	r := newHoldRig(t, true)
	mode(r, "auto")
	r.requestFor("Wants to run: go test ./...")
	assert.True(t, r.h.deriveSingleSessionState(context.Background(), r.sid, 0).NeedsInput, "the events still say the agent waits: auto-accept and the nudges see it at once")
	x := row(r)
	assert.Equal(t, false, x["waiting_for_input"], "auto mode may still decide it: the row says nothing waits")
	assert.Nil(t, x["waiting_kind"])
	for _, it := range needsYouAgentItems([]map[string]any{x}, time.Now()) {
		t.Errorf("an auto-mode request inside the grace is in Needs you: %v", it)
	}
	r.post(`{"event_type":"request_resolved","summary":"request resolved"}`)
	assert.Equal(t, false, row(r)["waiting_for_input"], "it resolved on its own: it never showed")

	// the same request still open after the grace: it shows
	autoModeGraceMs.Store(1)
	r2 := newHoldRig(t, true)
	mode(r2, "auto")
	r2.requestFor("Wants to run: go test ./...")
	require.Eventually(t, func() bool { return row(r2)["waiting_for_input"] == true }, 5*time.Second, 5*time.Millisecond, "a prompt still open after the grace is the Operator's")
	assert.Equal(t, "permission", row(r2)["waiting_kind"])

	// default mode: at once, whatever the grace
	autoModeGraceMs.Store(int64(time.Hour / time.Millisecond))
	r3 := newHoldRig(t, true)
	mode(r3, "default")
	r3.requestFor("Wants to run: ls")
	assert.Equal(t, true, row(r3)["waiting_for_input"], "a default-mode agent's request shows at once")
}
