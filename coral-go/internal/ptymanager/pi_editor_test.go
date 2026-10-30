package ptymanager

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const piRule = "────────────────────────────────────────────────────────────────────────"

// The reporter's screen (Coral 1.4.154 on linux, Pi 0.73.1, provider deepseek): an empty editor, two rules, the folder and the context line.
var piReporterEmpty = piRule + "\n\n" + piRule + "\n/w\n0.0%/1.0M (auto)            deepseek-v4-flash • high\n"

// A Pi 1.4.0 pane captured read-only from the Pi tester's session (the text scrubbed to a neutral reply; the layout as drawn): the agent's last reply, then the editor between its rules, then a
// folder line with the git state and the context line with the token counters.
var pi140Idle = " $ coral-board wait --from \"Orchestrator\" (timeout 10s)\n\n ... (2 earlier lines, ctrl+o to expand)\n   Expires:     2026-10-30T04:39:55Z\n\n" +
	" Coral will automatically wake you up with a terminal notification when\n this happens.\n STOP now and yield your turn. Do NOT poll or call sleep in a loop.\n\n Took 0.0s\n\n\n" +
	" Understood. I’ll hold until the next release is tagged.\n\n" + piRule + "\n\n" + piRule + "\n~/Software/coral/coral-go (detached)\n↑29k ↓436 R50k CH0.0% $0.004 (sub) 3.6%/272k (auto)     gpt-6-luna • medium\n"

func piWith(editor ...string) string {
	return "reply\n\n" + piRule + "\n" + strings.Join(editor, "\n") + "\n" + piRule + "\n/w (main)\n0.0%/1.0M (auto)            deepseek-v4-flash • high\n"
}

// #11165: Pi's editor has no marker; it is the lines between two rules above the footer.
func TestPiEditorIsReadBetweenItsRules(t *testing.T) {
	for name, screen := range map[string]string{"reporter's 0.73.1": piReporterEmpty, "1.4.0 pane": pi140Idle} {
		box, ok := inputBoxText(screen)
		assert.True(t, ok, name)
		assert.Empty(t, strings.TrimSpace(box), name+": empty")
		assert.True(t, InputBoxOnScreen(screen), name)
		assert.True(t, InputBoxEmpty(screen), name)
		assert.False(t, TextInInputBox(screen, "You have 3 unread messages"), name)
	}
	box, ok := inputBoxText(piWith("You have 3 unread messages on team. Run coral-board read"))
	require.True(t, ok)
	assert.Equal(t, "You have 3 unread messages on team. Run coral-board read", box)
	assert.True(t, TextInInputBox(piWith("You have 3 unread messages on team. Run coral-board read"), "You have 3 unread messages on team. Run coral-board read"))
	box, _ = inputBoxText(piWith("first line of a draft", "and a second"))
	assert.Equal(t, "first line of a draft and a second", box, "a wrapped or multi-line editor is one text")
	assert.Equal(t, boxOurs, inputBoxState(piWith("You have 3 unread messages"), "You have 3 unread messages", false))

	// Only Pi's footer makes the lines between two rules an editor: another screen's rules are not.
	_, ok = inputBoxText("some output\n" + piRule + "\ntext between\n" + piRule + "\nfooter line\n")
	assert.False(t, ok)
	_, ok = inputBoxText("")
	assert.False(t, ok)
	// Claude's box still reads by its marker.
	box, ok = inputBoxText(idleInputBox)
	assert.True(t, ok)
	assert.Empty(t, strings.TrimSpace(box))
}

// piModel is a Pi pane: its editor holds what was pasted and not submitted. A paste's own Enter is lost (the report), a separate Enter is not.
type piModel struct {
	mu        sync.Mutex
	editor    []string
	submitted []string
}

func (p *piModel) AgentScreen(context.Context, string, string, string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return piWith(strings.Join(p.editor, " ")), nil
}
func (p *piModel) SendEnter(context.Context, string, string, string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.editor) > 0 {
		p.submitted = append(p.submitted, strings.Join(p.editor, " "))
		p.editor = nil
	}
	return nil
}
func (p *piModel) paste(text string) { p.mu.Lock(); p.editor = append(p.editor, text); p.mu.Unlock() }
func (p *piModel) copies() int       { p.mu.Lock(); defer p.mu.Unlock(); return len(p.editor) }

// #11165 item 4: a notice whose Enter was lost is found in Pi's editor at the next send and given its Enter; it is never pasted after. However many times Coral asks, the editor holds at most one
// copy, and a person's draft in it is never added to.
func TestRetriesLeaveAtMostOneCopyInPisEditor(t *testing.T) {
	n := "pi-t-retries"
	defer ForgetSession(n)
	p := &piModel{}
	in := func(text string) AutomatedInput {
		return AutomatedInput{Term: p, Name: n, Text: text, What: "test", Send: func(context.Context) error { p.paste(text); return nil }}
	}
	text := "You have 3 unread messages on team. Run coral-board read"
	max := 0
	for i := 0; i < 8; i++ {
		_, err := DeliverAutomated(context.Background(), in(text))
		require.NoError(t, err)
		if c := p.copies(); c > max {
			max = c
		}
	}
	assert.LessOrEqual(t, max, 1, "never two copies in the editor")
	assert.NotEmpty(t, p.submitted, "the pending one got its Enter")
	for _, s := range p.submitted {
		assert.Equal(t, text, s, "what was submitted is one copy, not a pile")
	}

	// A person's draft is not added to, and not sent.
	ForgetSession(n)
	d := &piModel{editor: []string{"my own half-written thought"}}
	_, err := DeliverAutomated(context.Background(), AutomatedInput{Term: d, Name: n, Text: text, What: "test", Send: func(context.Context) error { d.paste(text); return nil }})
	require.NoError(t, err)
	assert.Equal(t, 1, d.copies(), "the draft alone")
	assert.Empty(t, d.submitted)
	s, ok := SkippedOf(n)
	require.True(t, ok)
	assert.Equal(t, SkipDraft, s.Why)
}

// An empty Pi editor takes the text once (the reporter's screens).
func TestAnEmptyPiEditorGetsTheTextOnce(t *testing.T) {
	for name, screen := range map[string]string{"0.73.1": piReporterEmpty, "1.4.0": pi140Idle} {
		n := "pi-t-empty-" + name
		a := &fakeAgent{screen: screen}
		assert.Equal(t, Sent, deliver(t, a, n, "You have 2 unread messages"), name)
		assert.Equal(t, []string{"You have 2 unread messages"}, a.sent(), name)
		ForgetSession(n)
	}
}

// #11165 item 2: for an agent whose box Coral cannot read at all, the same words are pasted once and then given an Enter, never pasted again after a copy that may still be waiting.
func TestABoxCoralCannotReadIsPastedOnceThenGivenItsEnter(t *testing.T) {
	n := "terminal-t-blind"
	defer ForgetSession(n)
	a := &fakeAgent{screen: "some program output\nno box here\n"}
	in := func(text string) AutomatedInput {
		x := a.input(n, text, false)
		x.AgentType = "terminal"
		return x
	}
	text := "You have 3 unread messages"
	d, err := DeliverAutomated(context.Background(), in(text))
	require.NoError(t, err)
	assert.Equal(t, Sent, d)
	for i := 0; i < 5; i++ {
		_, err = DeliverAutomated(context.Background(), in(text))
		require.NoError(t, err)
	}
	pastes := len(a.sent())
	assert.LessOrEqual(t, pastes, 3, "5 more asks are pasted at most every other time, never one after another")
	assert.GreaterOrEqual(t, a.enters, 2, "and the ones in between press the Enter of the copy that may be waiting")

	// Other words are a new notice: pasted.
	b := &fakeAgent{screen: "output\n"}
	x := b.input(n+"2", "first", false)
	x.AgentType = "terminal"
	_, _ = DeliverAutomated(context.Background(), x)
	y := b.input(n+"2", "different words", false)
	y.AgentType = "terminal"
	_, _ = DeliverAutomated(context.Background(), y)
	assert.Equal(t, []string{"first", "different words"}, b.sent())
	ForgetSession(n + "2")
}
