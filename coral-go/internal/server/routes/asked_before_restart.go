package routes

import (
	"strings"
	"time"

	"github.com/subgentic/coral/internal/sessionstate"
	"github.com/subgentic/coral/internal/store"
)

// askedBeforeRestart is the question, permission or plan an agent had open when it went to sleep (#10368, Mobile #10360): a restart of Coral ends a pty agent's CLI, and the request it was
// waiting on, which only lived in the agent's screen and in the live state, vanished with it: Needs you emptied and the chat showed only the sent line. The request is still in the agent's events
// (the last permission_request since its last turn boundary, with its words already cleaned and redacted), so a sleeping agent whose events end in an open request says what it asked: {text, kind, at}.
// The CLI that asked is gone, so nothing can answer it: the dashboard offers Restart and Dismiss, not answer buttons. Nil for an agent that is awake (its own state says it), archived, or has none.
func askedBeforeRestart(events []store.AgentEvent, sleeping, archived, afterRestart bool) map[string]any {
	if !sleeping || archived || len(events) == 0 {
		return nil
	}
	in := sessionstate.Input{}
	for _, ev := range events {
		in.Events = append(in.Events, ev.StateEvent())
	}
	st := sessionstate.Derive(in) // not asleep for this look: what the events say was open
	if !st.NeedsInput || st.WaitingSince.IsZero() {
		return nil
	}
	switch st.WaitingKind {
	case "question", "permission", "plan":
	default:
		return nil // a sign-in, a launch prompt, an MCP form: nothing that was asked of the person in the chat
	}
	text, _ := waitingLine(waitingSource(st.WaitingWants, st.WaitingSummary)).(string)
	text = strings.TrimSpace(strings.TrimPrefix(text, "Notification:"))
	if text == "" {
		text = map[string]string{"question": "Had a question for you", "plan": "A plan was ready for your review", "permission": "Needed your permission"}[st.WaitingKind]
	}
	return map[string]any{
		"text": text,
		"kind": st.WaitingKind,
		"at":   st.WaitingSince.UTC().Format(time.RFC3339),
		// whether the agent went to sleep because Coral stopped (its sleep reason coral_stopped): the dashboard says "before Coral restarted" only then, else "before it went to sleep"
		"after_restart": afterRestart,
	}
}
