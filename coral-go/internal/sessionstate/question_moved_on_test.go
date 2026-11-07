package sessionstate

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #14345 (the Operator's bug #14340): a question the person answered in the terminal stayed open in the live row and in Needs you until the question tool's PostToolUse, a stop, or a call that began
// half a minute later: the chat card was hidden (#14340) but the row still said "waiting". Claude does not write a new assistant entry while its own question is open: the next model call needs
// the question's answer. So an assistant entry in the transcript written after the question was raised is the agent's own evidence that it went on, and only that evidence clears it
// (Input.AssistantEntryAt: the computer's own clock, the transcript's, against the event log's).
func TestAnAssistantEntryAfterTheQuestionClosesIt(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	events := []Event{
		{Type: "prompt_submit", At: t0},
		{Type: "permission_request", Kind: "question", ToolName: "AskUserQuestion", At: t0.Add(10 * time.Second)},
	}
	st := Derive(Input{Events: events})
	assert.True(t, st.NeedsInput, "the question is open with no transcript evidence")
	assert.Equal(t, "question", st.WaitingKind)

	st = Derive(Input{Events: events, AssistantEntryAt: t0.Add(10*time.Second + 45*time.Second)})
	assert.False(t, st.NeedsInput, "an assistant entry written 45 s after the question (past the 30 s margin) went on: the question is over")
	assert.Empty(t, st.WaitingKind)
	assert.Empty(t, st.WaitingSummary)
	assert.True(t, st.InTurn, "the agent is in its turn, as after a call that started")
	assert.False(t, st.AwaitingUser, "and it is not waiting for the person")
}

// The margin: the entry that carries the question's own tool call can be written at the request's own moment (the hook and the transcript are two writers); it never answers the question.
func TestTheQuestionsOwnEntryAndOlderOnesLeaveItOpen(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	asked := t0.Add(10 * time.Second)
	events := []Event{
		{Type: "prompt_submit", At: t0},
		{Type: "permission_request", Kind: "question", ToolName: "AskUserQuestion", At: asked},
	}
	for name, at := range map[string]time.Time{
		"before the question":    asked.Add(-time.Minute),
		"at the question":        asked,
		"a second after it":      asked.Add(time.Second),
		"just inside the margin": asked.Add(MovedOnMargin),
		"no entry read (zero)":   {},
	} {
		st := Derive(Input{Events: events, AssistantEntryAt: at})
		assert.True(t, st.NeedsInput, name)
		assert.Equal(t, "question", st.WaitingKind, name)
	}
	st := Derive(Input{Events: events, AssistantEntryAt: asked.Add(MovedOnMargin + time.Millisecond)})
	assert.False(t, st.NeedsInput, "past the margin it closes")
}

// Only a question is closed this way: a permission prompt, a plan and an elicitation wait for a person whatever the agent has written, and a held notice of Coral's is not the agent's request.
func TestAnAssistantEntryDoesNotCloseOtherKindsOfRequest(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	for _, kind := range []string{"permission", "plan", "elicitation", ""} {
		events := []Event{
			{Type: "prompt_submit", At: t0},
			{Type: "permission_request", Kind: kind, ToolName: "Bash", At: t0.Add(10 * time.Second)},
		}
		st := Derive(Input{Events: events, AssistantEntryAt: t0.Add(5 * time.Minute)})
		assert.True(t, st.NeedsInput, "kind %q stays open", kind)
	}
}

// A second, newer question stays: the entry is older than it.
func TestAQuestionAskedAfterTheEntryStaysOpen(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	events := []Event{
		{Type: "prompt_submit", At: t0},
		{Type: "permission_request", Kind: "question", ToolName: "AskUserQuestion", At: t0.Add(10 * time.Second)},
		{Type: "tool_use", ToolName: "AskUserQuestion", ToolUseID: "toolu_q1", At: t0.Add(20 * time.Second)},
		{Type: "permission_request", Kind: "question", ToolName: "AskUserQuestion", At: t0.Add(60 * time.Second)},
	}
	st := Derive(Input{Events: events, AssistantEntryAt: t0.Add(30 * time.Second)})
	assert.True(t, st.NeedsInput, "the entry is from before the second question")
	assert.Equal(t, "question", st.WaitingKind)
}
