package terminalinput

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #14106 (Technical Writer's first-run walkthrough): answering a trust or permission prompt in the agent's terminal counted as typing to the agent, so Coral's first notice (a task assigned) waited a minute. The input that
// answers a prompt is not talking to the agent: PersonTalkedWithin leaves it out, PersonTypedWithin (the person was at the keyboard, read by the dialog timeouts) does not.
func TestAPromptAnswerIsNotTalkingToTheAgentButStillMeansThePersonIsThere(t *testing.T) {
	const sid = "aaaaaaaa-1406-4000-8000-000000000001"
	open := true
	SetPromptOpenCheck(func(id string) bool { return open && id == sid })
	t.Cleanup(func() { SetPromptOpenCheck(nil); promptAnswerGrace.Store(0) })

	Record(Person, "claude-"+sid+":0.0", Keys, "1") // the menu's "1. Yes", pressed while the prompt is open
	assert.True(t, PersonTypedWithin(sid, time.Minute), "the person is at the keyboard: the dialog timeouts still see it")
	assert.False(t, PersonTalkedWithin(sid, time.Minute), "but a prompt's answer is not talk: Coral's notices are not held for it")
}

func TestTheEnterRightAfterThePromptClosedIsStillItsAnswerButLaterTypingIsTalk(t *testing.T) {
	const sid = "aaaaaaaa-1406-4000-8000-000000000002"
	open := true
	SetPromptOpenCheck(func(id string) bool { return open && id == sid })
	t.Cleanup(func() { SetPromptOpenCheck(nil); promptAnswerGrace.Store(0) })
	promptAnswerGrace.Store(int64(120 * time.Millisecond)) // shortened for the test

	Record(Person, "claude-"+sid, Keys, "1")
	open = false // the request resolved
	Record(Person, "claude-"+sid, Keys, "Enter")
	assert.False(t, PersonTalkedWithin(sid, time.Minute), "the Enter that follows the answer, a moment after the prompt closed, is still the answer")

	time.Sleep(200 * time.Millisecond) // sleep-ok: the grace is a wall-clock time
	Record(Person, "claude-"+sid, Text, "now a real message")
	assert.True(t, PersonTalkedWithin(sid, time.Minute), "typing after the grace is talk")
}

func TestTypingWhenNoPromptIsOpenIsTalkAndWithoutACheckEverythingIs(t *testing.T) {
	const sid = "aaaaaaaa-1406-4000-8000-000000000003"
	Record(Person, "claude-"+sid, Text, "hello") // no check installed
	assert.True(t, PersonTalkedWithin(sid, time.Minute), "with no check, a person's input is talk (what it was)")

	const sid2 = "aaaaaaaa-1406-4000-8000-000000000004"
	SetPromptOpenCheck(func(string) bool { return false })
	t.Cleanup(func() { SetPromptOpenCheck(nil) })
	Record(Person, "claude-"+sid2, Text, "hello")
	assert.True(t, PersonTalkedWithin(sid2, time.Minute), "no prompt is open: the person is talking to the agent, and Coral's notices keep waiting for them")
	assert.False(t, PersonTalkedWithin("", time.Minute))
}
