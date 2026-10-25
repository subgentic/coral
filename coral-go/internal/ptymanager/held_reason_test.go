package ptymanager

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #7433: the dashboard said "Coral can't see the input box" for ANY send held over a minute, a long turn included. HeldReason names why the head of the queue is held, in a closed list, from what the
// gate decided; the words of every hold the gate can give are mapped here.
func TestHeldReasonNamesEveryHoldTheGateGives(t *testing.T) {
	for _, c := range []struct{ why, kind, want string }{
		{"signals: in turn", "", HeldTurn},
		{busyWhy + "Working (5s)", "", HeldTurn},
		{"signals: in turn, tool pending, screen: selection menu", kindPrompt, HeldPrompt},
		{"signals: blocked (permission)", "permission", HeldPrompt},
		{"signals: starting, screen: trust", kindTrust, HeldPrompt},
		{"signals: idle, screen: selection menu", kindPrompt, HeldPrompt},
		{"state: needs input", "", HeldPrompt},
		{"selection menu", "", HeldPrompt},
		{"prompt question: Proceed?", "", HeldPrompt},
		{"signals: idle, screen: a dialog", KindDialog, HeldDialog},
		{whyDraft, "", HeldDraft},
		{"the agent's input box isn't on screen yet", "", HeldBox},
		{"signals: idle, the agent's input box isn't on screen yet", "", HeldBox},
		{"signals: starting", "", HeldOther},
		{"signals: unknown state", "", HeldOther},
		{"earlier sends still held", "", HeldOther},
	} {
		assert.Equal(t, c.want, heldReasonOf(c.why, c.kind), "%q / %q", c.why, c.kind)
	}
	assert.Equal(t, []string{"turn", "prompt", "dialog", "draft", "box", "other"}, HeldReasons)
}

func TestHeldReasonIsTheHeadOfTheQueueAndEmptyWhenNothingIsHeld(t *testing.T) {
	name := "claude-held-reason-7433"
	assert.Equal(t, "", HeldReason(name))
	gate.mu.Lock()
	gate.held[name] = []*heldInput{{why: "signals: in turn"}, {why: whyDraft}}
	gate.mu.Unlock()
	t.Cleanup(func() { gate.mu.Lock(); delete(gate.held, name); delete(gate.inflight, name); gate.mu.Unlock() })
	assert.Equal(t, HeldTurn, HeldReason(name), "the oldest send's reason")
	gate.mu.Lock()
	if gate.inflight == nil {
		gate.inflight = map[string]*heldInput{}
	}
	gate.inflight[name] = &heldInput{why: whyDraft}
	gate.mu.Unlock()
	assert.Equal(t, HeldDraft, HeldReason(name), "the send being tried now is the oldest")
}
