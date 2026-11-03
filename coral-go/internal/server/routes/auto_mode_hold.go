package routes

import (
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/sessionstate"
)

// In Claude's auto mode a permission prompt appears and Claude's own classifier then decides it, seconds later (#12694, the Operator: "I see an item show up, but then it is already acted on before I click it").
// Coral raised the item the moment the prompt appeared. So a permission request of a Claude agent in auto mode is held back from what waits for the Operator (the live row's waiting_for_input: the Inbox's Needs
// you, the phone push, the dashboard's dots) until auto mode has had its chance: it is shown only when the prompt is STILL open after the grace. A request that is not a permission (a question to the person,
// a plan to approve, an elicitation) is Claude asking the person, not the classifier: shown at once, as every request of every other mode. Only the row is held: the events, auto-accept and the nudges
// still see the request at once (sessionstate.Derive is untouched), so nothing Coral does for the agent waits.
//
// autoModeGraceMs is the grace. 8 seconds is the figure the Operator's task named; it has NOT been measured on a real auto-mode run (that needs a signed-in Claude, which an isolated test home does not have):
// the number is one place to change, and a setting would be the next step if it needs tuning.
var autoModeGraceMs atomic.Int64

func init() { autoModeGraceMs.Store(8000) }

func autoModeGrace() time.Duration { return time.Duration(autoModeGraceMs.Load()) * time.Millisecond }

// heldForAutoMode reports whether st is an open permission request of the agent's own that auto mode may still decide: the live mode is auto, the request is a permission, it began less than grace ago.
func heldForAutoMode(mode any, st sessionstate.State, now time.Time, grace time.Duration) bool {
	m, _ := mode.(string)
	return grace > 0 && m == "auto" && st.NeedsInput && st.OwnRequest && st.WaitingKind == "permission" && !st.WaitingSince.IsZero() && now.Sub(st.WaitingSince) < grace
}

// holdForAutoMode is st as the live row shows it: while auto mode may still decide the agent's permission request, the row says the agent waits for nothing.
func (h *SessionsHandler) holdForAutoMode(sessionID string, st sessionstate.State, now time.Time) sessionstate.State {
	if !heldForAutoMode(h.liveMode(sessionID), st, now, autoModeGrace()) {
		return st
	}
	st.NeedsInput, st.OwnRequest = false, false
	st.WaitingReason, st.WaitingSummary, st.WaitingKind, st.WaitingWants = "", "", "", ""
	st.WaitingSince = time.Time{}
	return st
}
