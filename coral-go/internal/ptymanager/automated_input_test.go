package ptymanager

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/tmux"
)

// Automated input (#7727): one look at the screen, then the text and its Enter at once, or nothing and nothing kept.

const (
	// A Yes-highlighted permission frame: Enter takes "Yes".
	permissionMenu = " Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n\n Esc to cancel · Tab to amend\n"
	idleInputBox   = "⏺ Done.\n\n──────────────────────────────────────────\n❯ \n──────────────────────────────────────────\n  ? for shortcuts\n"

	// The DevOps Engineer's terminal on 2026-10-26 (#7727), names scrubbed: the turn is over, one background shell runs, and the box is empty. Held for ten minutes by the old rules.
	claudeIdleWithShell = "⏺ Noted: batch 3 so far is the three commits. I'll apply it on batch 2's head once batch 2 lands.\n\n" +
		"✻ Cogitated for 4s · done 5:38 PM · 1 shell still running\n\n" +
		"──────────────────────────────────────────────────────────────────────────\n" +
		"❯ \n" +
		"──────────────────────────────────────────────────────────────────────────\n" +
		"  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage\n" +
		"                                  ✔ Update installed · Restart to update\n"

	// UI Accessibility's, the same night: a monitor in the footer, and "Read the board" typed in the box with no Enter.
	claudeMonitorWithText = "✻ Crunched for 53s · done 5:45 PM · 1 monitor still running\n\n" +
		"────────────────────────────────────────────────────────────────────────────────────\n" +
		"❯ Read the board\n" +
		"────────────────────────────────────────────────────────────────────────────────────\n" +
		"  ⏵⏵ bypass permissions on · 1 monitor · ↓ to manage\n" +
		"                                            ✔ Update installed · Restart to update\n"

	// Claude mid-turn: a working line above an empty box, the footer saying what the keys do.
	claudeMidTurn = "⏺ Bash(go test ./...)\n  ⎿  Running…\n\n✻ Thinking… (12s · esc to interrupt)\n\n" +
		"──────────────────────────────────────────────────────────────────────\n" +
		"❯ \n" +
		"──────────────────────────────────────────────────────────────────────\n" +
		"  ⏵⏵ bypass permissions on · ↓ to manage\n"

	trustDialog = " Do you trust the files in this folder?\n\n /work/project\n\n ❯ 1. Yes, proceed\n   2. No, exit\n\n Enter to confirm · Esc to exit\n"
)

// fakeAgent is a terminal whose screen the test sets, recording what is typed and the Enters pressed.
type fakeAgent struct {
	mu      sync.Mutex
	screen  string
	readErr error
	typed   []string
	enters  int
}

func (f *fakeAgent) AgentScreen(context.Context, string, string, string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.screen, f.readErr
}
func (f *fakeAgent) SendEnter(context.Context, string, string, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.enters++
	return nil
}
func (f *fakeAgent) show(s string) { f.mu.Lock(); f.screen = s; f.mu.Unlock() }
func (f *fakeAgent) sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.typed...)
}
func (f *fakeAgent) input(name, text string, requireBox bool) AutomatedInput {
	return AutomatedInput{Term: f, Name: name, Text: text, What: "test", RequireInputBox: requireBox,
		Send: func(context.Context) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.typed = append(f.typed, text)
			return nil
		}}
}

func quickLaunchWaits(t *testing.T) {
	t.Helper()
	setWaits(t, func(w *waitTimings) {
		w.launchWait, w.launchFallback, w.launchEvery = 400*time.Millisecond, 120*time.Millisecond, 10*time.Millisecond
	})
}

func deliver(t *testing.T, a *fakeAgent, name, text string) Delivery {
	t.Helper()
	d, err := DeliverAutomated(context.Background(), a.input(name, text, false))
	require.NoError(t, err)
	return d
}

// The night's two agents: a turn that is over with a shell or a monitor still running is an ordinary prompt: the text and its Enter go at once.
func TestAnIdleAgentWithABackgroundShellOrMonitorGetsTheText(t *testing.T) {
	a := &fakeAgent{screen: claudeIdleWithShell}
	assert.Equal(t, Sent, deliver(t, a, "claude-t-shell", "nudge one"))
	assert.Equal(t, []string{"nudge one"}, a.sent())
	_, ok := SkippedOf("claude-t-shell")
	assert.False(t, ok, "nothing was skipped")
	for _, footer := range []string{"1 shell · ↓ to manage", "1 monitor · ↓ to manage", "2 shells · ↓ to manage"} {
		open, why := PromptOnScreen(strings.Replace(claudeIdleWithShell, "1 shell · ↓ to manage", footer, 1))
		assert.False(t, open, "%q is not a prompt (%s)", footer, why)
	}
}

// Mid-turn text is the harness's to queue: a working agent gets it too.
func TestAMidTurnAgentGetsTheText(t *testing.T) {
	a := &fakeAgent{screen: claudeMidTurn}
	assert.Equal(t, Sent, deliver(t, a, "claude-t-mid", "a message mid-turn"))
	assert.Equal(t, []string{"a message mid-turn"}, a.sent())
}

// A readable screen Coral does not recognise gets the text: "ambiguous" is not a reason to skip.
func TestAScreenCoralDoesNotRecogniseGetsTheText(t *testing.T) {
	a := &fakeAgent{screen: "Some new CLI v9 :: type here\nstatus: working"}
	assert.Equal(t, Sent, deliver(t, a, "claude-t-unknown", "hello"))
	assert.Equal(t, []string{"hello"}, a.sent())
}

// The reason for it all (#3431): typing into a menu answers it. A Yes-highlighted permission frame, a selection list and a trust dialog each get nothing, and nothing is kept for later.
func TestAnOpenPromptOrMenuGetsNothingAndNothingIsKept(t *testing.T) {
	for name, screen := range map[string]string{
		"a Yes-highlighted permission frame": permissionMenu,
		"a trust dialog":                     trustDialog,
		"a selection list":                   " Select model\n\n ❯ 1. Default (recommended)\n   2. Opus\n   3. Haiku\n\n Enter to select · Esc to exit\n",
	} {
		a := &fakeAgent{screen: screen}
		n := "claude-t-prompt"
		assert.Equal(t, Skipped, deliver(t, a, n, "You have 1 unread message"), name)
		assert.Empty(t, a.sent(), name)
		assert.Zero(t, a.enters, "%s: no Enter either", name)
		s, ok := SkippedOf(n)
		require.True(t, ok, name)
		assert.True(t, strings.HasPrefix(s.Why, SkipPrompt), "%s: %s", name, s.Why)

		a.show(idleInputBox)              // the menu is answered: nothing is typed by itself afterwards
		time.Sleep(60 * time.Millisecond) // sleep-ok: nothing is queued, so nothing may arrive
		assert.Empty(t, a.sent(), name+": nothing queued")
		assert.Equal(t, Sent, deliver(t, a, n, "next"), name)
		_, ok = SkippedOf(n)
		assert.False(t, ok, name+": a send typed clears the skip")
		ForgetSession(n)
	}
}

// A person's draft counts like a menu: the nudge would be added to it and sent with it (UI Accessibility's "Read the board").
func TestAPersonsDraftGetsNothing(t *testing.T) {
	n := "claude-t-draft"
	defer ForgetSession(n)
	a := &fakeAgent{screen: claudeMonitorWithText}
	assert.Equal(t, Skipped, deliver(t, a, n, "You have 1 unread message"), "text Coral did not type is a draft")
	assert.Empty(t, a.sent())
	assert.Zero(t, a.enters)
	s, _ := SkippedOf(n)
	assert.Equal(t, SkipDraft, s.Why)
}

// Coral's own leftover (its text typed, the Enter not taken) is decided by an exact match with the last text Coral typed to the session: it is sent, and the new text is not typed after it.
func TestCoralsOwnLeftoverIsSentAndAnythingElseIsADraft(t *testing.T) {
	n := "claude-t-leftover"
	defer ForgetSession(n)
	a := &fakeAgent{screen: idleInputBox}
	assert.Equal(t, Sent, deliver(t, a, n, "Read the board"))
	assert.Equal(t, []string{"Read the board"}, a.sent())
	var recorded bool

	// an earlier skip (a prompt was open) is over once Coral's own text is sent
	a.show(permissionMenu)
	assert.Equal(t, Skipped, deliver(t, a, n, "You have 2 unread messages"))
	_, recorded = SkippedOf(n)
	require.True(t, recorded)

	// its Enter did not take: the box still holds exactly that text
	a.show(claudeMonitorWithText)
	assert.Equal(t, Skipped, deliver(t, a, n, "You have 2 unread messages"), "the new text is not typed after the old one")
	assert.Equal(t, []string{"Read the board"}, a.sent(), "nothing typed")
	assert.Equal(t, 1, a.enters, "the old text's Enter is pressed")
	_, recorded = SkippedOf(n)
	assert.False(t, recorded, "Coral's own leftover that got its Enter is not a skip")
	a.show(idleInputBox) // the Enter took: the box is empty
	assert.Equal(t, Sent, deliver(t, a, n, "You have 2 unread messages"), "the next send types into the box (the leftover is forgotten once sent)")

	// the person added words to Coral's text: a draft
	b := &fakeAgent{screen: idleInputBox}
	assert.Equal(t, Sent, deliver(t, b, n, "Read the board"))
	b.show(strings.Replace(claudeMonitorWithText, "Read the board", "Read the board and then fix it", 1))
	assert.Equal(t, Skipped, deliver(t, b, n, "more"))
	assert.Zero(t, b.enters, "a draft is never sent")
	s, _ := SkippedOf(n)
	assert.Equal(t, SkipDraft, s.Why)

	// Coral lost its record (a restart): treated as a draft, once; the next nudge types into an empty box
	ForgetSession(n)
	c := &fakeAgent{screen: claudeMonitorWithText}
	assert.Equal(t, Skipped, deliver(t, c, n, "x"))
	assert.Zero(t, c.enters)
}

// A screen that cannot be read, or is empty, gets nothing; DeliverNow (a person's button) is not stopped by it.
func TestAnUnreadableScreenGetsNothing(t *testing.T) {
	n := "claude-t-unreadable"
	defer ForgetSession(n)
	a := &fakeAgent{screen: idleInputBox, readErr: errors.New("capture failed")}
	assert.Equal(t, Skipped, deliver(t, a, n, "x"))
	assert.Empty(t, a.sent())
	s, _ := SkippedOf(n)
	assert.Equal(t, SkipUnreadable, s.Why)

	b := &fakeAgent{screen: "  \n \n"}
	assert.Equal(t, Skipped, deliver(t, b, n, "x"), "an empty screen")
	assert.Empty(t, b.sent())

	d, err := DeliverNow(context.Background(), a.input(n, "now", false))
	require.NoError(t, err)
	assert.Equal(t, Sent, d, "a person's Send now types where the screen cannot be read")
	assert.Equal(t, []string{"now"}, a.sent())

	// ...but never into an open prompt or over a draft
	p := &fakeAgent{screen: permissionMenu}
	d, _ = DeliverNow(context.Background(), p.input(n, "now", false))
	assert.Equal(t, Skipped, d)
	assert.Empty(t, p.sent())
	dr := &fakeAgent{screen: claudeMonitorWithText}
	d, _ = DeliverNow(context.Background(), dr.input(n, "now", false))
	assert.Equal(t, Skipped, d)
	assert.Empty(t, dr.sent())
}

// A terminal that has no screen to read is typed to (there is nothing to look at).
func TestATerminalWithNoScreenIsTypedTo(t *testing.T) {
	var typed []string
	d, err := DeliverAutomated(context.Background(), AutomatedInput{Term: struct{}{}, Name: "claude-t-noscreen", Text: "hi", What: "test",
		Send: func(context.Context) error { typed = append(typed, "hi"); return nil }})
	require.NoError(t, err)
	assert.Equal(t, Sent, d)
	assert.Equal(t, []string{"hi"}, typed)
}

// A prompt that opens between the text and its Enter does not take the Enter: it is not pressed, and nothing is kept.
func TestAPromptOpeningBeforeTheEnterWithholdsIt(t *testing.T) {
	n := "claude-t-enter"
	defer ForgetSession(n)
	a := &fakeAgent{screen: idleInputBox}
	in := AutomatedInput{Term: a, Name: n, Text: "hello", What: "test",
		Send: func(ctx context.Context) error {
			a.mu.Lock()
			a.typed = append(a.typed, "hello")
			a.screen = permissionMenu // the agent asks for permission right now
			a.mu.Unlock()
			if !tmux.EnterAllowed(ctx) {
				return tmux.ErrEnterWithheld
			}
			a.mu.Lock()
			a.typed = append(a.typed, "<Enter>")
			a.mu.Unlock()
			return nil
		}}
	d, err := DeliverAutomated(context.Background(), in)
	require.NoError(t, err)
	assert.Equal(t, Skipped, d)
	assert.Equal(t, []string{"hello"}, a.sent(), "no Enter into the open prompt")
	s, _ := SkippedOf(n)
	assert.Equal(t, SkipEnter, s.Why)
}

// A launch's first prompt is the one send that waits: for the input box, through a blank screen and a trust dialog; and for an agent whose box is never recognised, it falls back
// to the usual look once the fallback time has passed.
func TestAFirstPromptWaitsForTheInputBox(t *testing.T) {
	quickLaunchWaits(t)
	a := &fakeAgent{screen: ""}
	n := "claude-t-launch"
	done := make(chan Delivery, 1)
	go func() {
		d, _ := DeliverAutomated(context.Background(), a.input(n, "Build the feature", true))
		done <- d
	}()
	time.Sleep(30 * time.Millisecond) // sleep-ok: a blank screen, then a trust dialog: the prompt never answers it
	a.show(trustDialog)
	time.Sleep(30 * time.Millisecond) // sleep-ok: still waiting
	assert.Empty(t, a.sent())
	a.show(idleInputBox)
	select {
	case d := <-done:
		assert.Equal(t, Sent, d)
	case <-time.After(3 * time.Second):
		t.Fatal("the first prompt never went")
	}
	assert.Equal(t, []string{"Build the feature"}, a.sent())

	// an agent whose box is not recognised: the fallback
	u := &fakeAgent{screen: "Some new CLI v9 :: type here"}
	d, err := DeliverAutomated(context.Background(), u.input("claude-t-launch2", "Build it", true))
	require.NoError(t, err)
	assert.Equal(t, Sent, d)
	assert.Equal(t, []string{"Build it"}, u.sent())

	// a prompt that stays open is never answered, and the send gives up after the wait
	o := &fakeAgent{screen: trustDialog}
	d, err = DeliverAutomated(context.Background(), o.input("claude-t-launch3", "Build it", true))
	require.NoError(t, err)
	assert.Equal(t, Skipped, d)
	assert.Empty(t, o.sent())
}

// ForgetSession clears the old process's typed text and skipped send and notifies subscribers.
func TestForgetSessionClearsTypedTextAndSkip(t *testing.T) {
	n := "claude-t-forget"
	a := &fakeAgent{screen: idleInputBox}
	d, err := DeliverAutomated(context.Background(), a.input(n, "nudge", false))
	require.NoError(t, err)
	require.Equal(t, Sent, d)
	require.Equal(t, []string{"nudge"}, a.sent())
	gate.mu.Lock()
	_, typed := gate.lastTyped[n]
	gate.mu.Unlock()
	require.True(t, typed)
	a.show(permissionMenu)
	d, err = DeliverAutomated(context.Background(), a.input(n, "held nudge", false))
	require.NoError(t, err)
	require.Equal(t, Skipped, d)
	_, skipped := SkippedOf(n)
	require.True(t, skipped)
	forgotten := make(chan string, 1)
	stop := OnSessionForgotten(func(name string) { forgotten <- name })
	defer stop()
	ForgetSession(n)
	gate.mu.Lock()
	_, typed = gate.lastTyped[n]
	gate.mu.Unlock()
	assert.False(t, typed)
	_, skipped = SkippedOf(n)
	assert.False(t, skipped)
	assert.Equal(t, n, <-forgotten)
}

// Claude's session survey ("How is Claude doing? ... 0: Dismiss") takes digit keys only: with a real capture of it on screen, a board nudge is typed (the agent is
// not left deaf to the board until a person dismisses it), and a text that starts with a digit, which would answer it, is not.
func TestTheSessionSurveyDoesNotKeepTheBoardFromAnAgent(t *testing.T) {
	raw, err := os.ReadFile("testdata/screens/claude/2.1.300/feedback_survey.ansi")
	require.NoError(t, err)
	n := "claude-t-survey"
	defer ForgetSession(n)
	a := &fakeAgent{screen: string(raw)}
	assert.Equal(t, Sent, deliver(t, a, n, "You have 1 unread message"))
	assert.Equal(t, []string{"You have 1 unread message"}, a.sent())
	assert.Equal(t, Skipped, deliver(t, a, n, "1"), "a digit would answer the survey")
	assert.Len(t, a.sent(), 1)
}

// A person's own pasted draft is not Coral's leftover (Security's #7757 read): a long text shows in the box as a placeholder ("[Pasted text #1 +40 lines]"), and Coral's last text having been a long paste
// must not make a placeholder of the person's Coral's own, or the nudge would press the Enter of what the person pasted.
func TestAPersonsOwnPastedDraftIsNotCoralsLeftover(t *testing.T) {
	n := "claude-t-pasted-draft"
	defer ForgetSession(n)
	person := strings.Replace(idleInputBox, "❯ \n", "❯ [Pasted text #1 +40 lines]\n", 1)

	// Coral's last text was a long paste, long ago (an agent's first prompt); the person pastes their own text now
	gate.noteTyped(n, strings.Repeat("a long first prompt. ", 30), true)
	gate.backdateTyped(n, 10*time.Minute)
	a := &fakeAgent{screen: person}
	assert.Equal(t, Skipped, deliver(t, a, n, "You have 1 unread message"))
	assert.Zero(t, a.enters, "the person's paste is never submitted by Coral")
	assert.Empty(t, a.sent())
	s, _ := SkippedOf(n)
	assert.Equal(t, SkipDraft, s.Why)

	// a look at an empty box forgets Coral's text: it was taken, and a placeholder that comes later cannot be it
	gate.noteTyped(n, strings.Repeat("a long first prompt. ", 30), true)
	b := &fakeAgent{screen: idleInputBox}
	b.input(n, "x", false).look(context.Background())
	_, kept := gate.typedFor(n)
	assert.False(t, kept, "an empty box ends Coral's claim on what it typed")
	b.show(person)
	assert.Equal(t, Skipped, deliver(t, b, n, "second"))
	assert.Zero(t, b.enters)

	// Coral's own long paste that did not get its Enter, a moment ago, is still its leftover
	gate.noteTyped(n, strings.Repeat("a long first prompt. ", 30), true)
	c := &fakeAgent{screen: person}
	assert.Equal(t, Skipped, deliver(t, c, n, "x"))
	assert.Equal(t, 1, c.enters, "Coral's own recent paste gets its Enter")
}

// backdateTyped makes the last text Coral typed to name d older (a test of the leftover window).
func (g *inputGate) backdateTyped(name string, d time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	m := g.lastTyped[name]
	m.at = m.at.Add(-d)
	g.lastTyped[name] = m
}
