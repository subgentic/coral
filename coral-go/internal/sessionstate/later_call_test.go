package sessionstate

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #11352: a permission request whose call never finishes (the person refused it, or answered it in the terminal and the agent tried another command) stayed open for the rest of the turn, and
// the chat and the Inbox kept saying "Permission needed" while the agent ran on. A call that STARTED after the request was opened proves the agent is past it: Claude does not begin a call
// while a prompt of its own is open. Real case, the operator's own events: a Bash request for toolu_01BDoh..., then, 4 minutes later, a different Bash call (started 2 minutes into the gap)
// finished with another id, and the turn went on with no Stop.
func TestACallThatStartedAfterTheRequestClosesIt(t *testing.T) {
	t0 := time.Date(2026, 10, 30, 17, 28, 0, 0, time.UTC)
	prompt := Event{Type: "prompt_submit", At: t0}
	request := Event{Type: "permission_request", Kind: "permission", ToolName: "Bash", CallIDs: []string{"toolu_asked"}, At: t0.Add(56 * time.Second)}
	// Finished at 17:33:41 after 157 s: it started at 17:31:04, well after the request.
	later := Event{Type: "tool_use", ToolName: "Bash", ToolUseID: "toolu_other", At: t0.Add(5*time.Minute + 41*time.Second), Started: t0.Add(3*time.Minute + 4*time.Second)}

	st := Derive(Input{Events: []Event{prompt, request}})
	assert.True(t, st.NeedsInput, "the request is open before the later call")

	st = Derive(Input{Events: []Event{prompt, request, later}})
	assert.False(t, st.NeedsInput, "a call that started after the request closes it")
	assert.Empty(t, st.WaitingSummary)
	assert.True(t, st.InTurn, "the agent is in its turn")
}

// The calls the prompt is about, and their siblings, began before it: they must not close it (#6687: an auto-allowed Bash beside one that waits for approval finishes first).
func TestACallThatStartedBeforeTheRequestLeavesItOpen(t *testing.T) {
	t0 := time.Date(2026, 10, 30, 17, 28, 0, 0, time.UTC)
	prompt := Event{Type: "prompt_submit", At: t0}
	request := Event{Type: "permission_request", Kind: "permission", ToolName: "Bash", CallIDs: []string{"toolu_asked"}, At: t0.Add(10 * time.Second)}
	sibling := Event{Type: "tool_use", ToolName: "Bash", ToolUseID: "toolu_sibling", At: t0.Add(20 * time.Second), Started: t0.Add(9 * time.Second)}
	st := Derive(Input{Events: []Event{prompt, request, sibling}})
	assert.True(t, st.NeedsInput, "a parallel call that started before the request does not answer it")

	// Within the jitter of the clocks (the hook's and Coral's), a call that began at the request's own moment is a sibling too.
	nearly := Event{Type: "tool_use", ToolName: "Bash", ToolUseID: "toolu_near", At: t0.Add(20 * time.Second), Started: t0.Add(10*time.Second + 500*time.Millisecond)}
	st = Derive(Input{Events: []Event{prompt, request, nearly}})
	assert.True(t, st.NeedsInput, "half a second after the request is still its own moment")

	// An event that does not say when its call started proves nothing.
	unknown := Event{Type: "tool_use", ToolName: "Bash", ToolUseID: "toolu_unknown", At: t0.Add(5 * time.Minute)}
	st = Derive(Input{Events: []Event{prompt, request, unknown}})
	assert.True(t, st.NeedsInput, "without a start time the other call does not answer the request")
}

// Only the request the later call began after is closed; a second, newer request stays.
func TestALaterCallClosesOnlyTheRequestsOlderThanItsStart(t *testing.T) {
	t0 := time.Date(2026, 10, 30, 17, 28, 0, 0, time.UTC)
	prompt := Event{Type: "prompt_submit", At: t0}
	first := Event{Type: "permission_request", Kind: "permission", ToolName: "Bash", CallIDs: []string{"toolu_a"}, At: t0.Add(10 * time.Second)}
	second := Event{Type: "permission_request", Kind: "permission", ToolName: "Edit", CallIDs: []string{"toolu_b"}, At: t0.Add(100 * time.Second)}
	later := Event{Type: "tool_use", ToolName: "Bash", ToolUseID: "toolu_c", At: t0.Add(120 * time.Second), Started: t0.Add(50 * time.Second)}
	st := Derive(Input{Events: []Event{prompt, first, second, later}})
	assert.True(t, st.NeedsInput, "the Edit request is newer than the call's start: still open")
}

// #11352, the Mobile Beta Tester's reproduction (#136683): the PermissionRequest of a Bash call, then the PreToolUse of the SAME call: the tool is starting, so the permission was given, and the
// request is closed at once, not when a command that runs for minutes ends. The server writes a request_resolved event with the call's id for a PreToolUse that comes while a request of the session is open.
func TestAToolStartOfTheRequestedCallClosesIt(t *testing.T) {
	t0 := time.Date(2026, 10, 30, 17, 28, 0, 0, time.UTC)
	prompt := Event{Type: "prompt_submit", At: t0}
	request := Event{Type: "permission_request", Kind: "permission", ToolName: "Bash", CallIDs: []string{"toolu_A"}, At: t0.Add(5 * time.Second)}
	start := Event{Type: "request_resolved", ToolName: "Bash", ToolUseID: "toolu_A", At: t0.Add(6 * time.Second)}
	st := Derive(Input{Events: []Event{prompt, request, start}})
	assert.False(t, st.NeedsInput, "the call the request is about has started")
	assert.True(t, st.InTurn)
}

// A start of another call, once the request had been open for longer than the clocks' jitter, closes it as well (the real case: the call that ran had another id than the request's guess).
func TestAToolStartOfAnotherCallAfterTheJitterClosesIt(t *testing.T) {
	t0 := time.Date(2026, 10, 30, 17, 28, 0, 0, time.UTC)
	prompt := Event{Type: "prompt_submit", At: t0}
	request := Event{Type: "permission_request", Kind: "permission", ToolName: "Bash", CallIDs: []string{"toolu_guess"}, At: t0.Add(5 * time.Second)}
	assert.False(t, Derive(Input{Events: []Event{prompt, request, {Type: "request_resolved", ToolName: "Bash", ToolUseID: "toolu_real", At: t0.Add(2 * time.Minute)}}}).NeedsInput)
	// A sibling's start at the request's own moment (its PreToolUse recorded just after) leaves it open.
	assert.True(t, Derive(Input{Events: []Event{prompt, request, {Type: "request_resolved", ToolName: "Bash", ToolUseID: "toolu_sib", At: t0.Add(5*time.Second + 400*time.Millisecond)}}}).NeedsInput)
}

// With nothing open a start changes nothing: not the phase, not the time of it.
func TestAToolStartWithNoRequestOpenChangesNothing(t *testing.T) {
	t0 := time.Date(2026, 10, 30, 17, 28, 0, 0, time.UTC)
	before := Derive(Input{Events: []Event{{Type: "prompt_submit", At: t0}, {Type: "stop", At: t0.Add(time.Second)}}})
	after := Derive(Input{Events: []Event{{Type: "prompt_submit", At: t0}, {Type: "stop", At: t0.Add(time.Second)}, {Type: "request_resolved", ToolName: "Bash", ToolUseID: "x", At: t0.Add(time.Minute)}}})
	assert.Equal(t, before.AwaitingUser, after.AwaitingUser)
	assert.Equal(t, before.Since, after.Since)
}
