package ptymanager

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7579: Send now forces. When the agent's input box is not on the screen the reader sees, the normal release keeps holding (it cannot tell the paste landed); Send now types the message and its Enter, and says
// so. Two refusals remain: a real prompt on screen, and a draft in the box that is not Coral's.

// A hold that never typed anything (the state says the agent needs input, the screen shows no box): Send now pastes and presses Enter, once, without looking for the text in a box it cannot see.
func TestSendNowPastesWhenTheInputBoxIsNotOnTheScreen(t *testing.T) {
	stuckGate(t, time.Hour, time.Hour)
	name := "claude-sendnow-nobox"
	term := &stuckTerm{screen: noBox}
	SetNeedsInputFunc(func(context.Context, string, string, string) bool { return true }) // the stale state of the operator's case
	t.Cleanup(func() { DropHeld(name, "test done"); waitGateIdle(t) })

	d, err := DeliverAutomated(context.Background(), pasteSend(term, name, "[board] QA: please look at #12", "board message", false))
	require.NoError(t, err)
	require.Equal(t, Held, d)
	time.Sleep(80 * time.Millisecond) // the retry loop keeps holding it: it cannot see the box
	pasted, enters := term.got()
	require.Empty(t, pasted)
	require.Zero(t, enters)
	require.Equal(t, 1, HeldCount(name))

	res, err := SendHeldNow(context.Background(), name, "")
	require.NoError(t, err)
	assert.Equal(t, SendNowResult{Sent: 1}, res)
	pasted, enters = term.got()
	assert.Equal(t, []string{"[board] QA: please look at #12"}, pasted, "typed once")
	assert.Equal(t, 1, enters, "and its Enter")
	assert.Zero(t, HeldCount(name))

	res, err = SendHeldNow(context.Background(), name, "") // a second press finds nothing
	require.NoError(t, err)
	assert.Equal(t, SendNowResult{}, res)
	pasted, _ = term.got()
	assert.Len(t, pasted, 1)
}

// A paste that was made and not seen in a box that cannot be found (held after pasting): Send now presses only its Enter, never pastes the text a second time.
func TestSendNowAfterAnUnseenPasteOnlyPressesEnter(t *testing.T) {
	stuckGate(t, time.Hour, time.Hour)
	name := "claude-sendnow-pasted"
	term := &stuckTerm{screen: noBox}
	t.Cleanup(func() { DropHeld(name, "test done"); waitGateIdle(t) })

	d, err := DeliverAutomated(context.Background(), pasteSend(term, name, "[board] QA: please look at #13", "board message", false))
	require.NoError(t, err)
	require.Equal(t, Held, d, "pasted, its Enter withheld: the paste did not show in a box")
	pasted, enters := term.got()
	require.Len(t, pasted, 1)
	require.Zero(t, enters, "its Enter was withheld (stuckTerm counts an Enter only when the check allowed it)")

	res, err := SendHeldNow(context.Background(), name, "")
	require.NoError(t, err)
	assert.Equal(t, 1, res.Sent)
	pasted, enters = term.got()
	assert.Len(t, pasted, 1, "the text is not pasted again")
	assert.Equal(t, 1, enters, "only its Enter is pressed")
}

// A draft in the box is never typed after or over: Send now refuses and says so; the send stays held.
func TestSendNowRefusesADraftInTheBox(t *testing.T) {
	stuckGate(t, time.Hour, time.Hour)
	name := "claude-sendnow-draft"
	term := &stuckTerm{screen: claudeBoxScreen("my own half-typed question", 100)}
	SetNeedsInputFunc(func(context.Context, string, string, string) bool { return true })
	t.Cleanup(func() { DropHeld(name, "test done"); waitGateIdle(t) })

	d, err := DeliverAutomated(context.Background(), pasteSend(term, name, "[board] QA: please look at #14", "board message", false))
	require.NoError(t, err)
	require.Equal(t, Held, d)
	res, err := SendHeldNow(context.Background(), name, "")
	require.NoError(t, err)
	assert.True(t, res.Draft)
	assert.Zero(t, res.Sent)
	assert.Equal(t, 1, res.Left)
	pasted, enters := term.got()
	assert.Empty(t, pasted)
	assert.Zero(t, enters)
}

// A real prompt on the screen: nothing typed (the screen is read at the press, not the state that may be wrong).
func TestSendNowRefusesARealPromptOnTheScreen(t *testing.T) {
	stuckGate(t, time.Hour, time.Hour)
	name := "claude-sendnow-realprompt"
	term := &stuckTerm{screen: noBox}
	SetNeedsInputFunc(func(context.Context, string, string, string) bool { return true })
	t.Cleanup(func() { DropHeld(name, "test done"); waitGateIdle(t) })

	d, err := DeliverAutomated(context.Background(), pasteSend(term, name, "[board] QA: please look at #15", "board message", false))
	require.NoError(t, err)
	require.Equal(t, Held, d)
	term.set(permissionMenu, false)
	res, err := SendHeldNow(context.Background(), name, "")
	require.NoError(t, err)
	assert.NotEmpty(t, res.Prompt)
	assert.Zero(t, res.Sent)
	pasted, enters := term.got()
	assert.Empty(t, pasted)
	assert.Zero(t, enters)
	assert.Equal(t, 1, HeldCount(name))
}

// A prompt that opens after the press's own screen check, between the paste and its Enter: the Enter is withheld and the send stays held (the check inside the forced paste, which the press check cannot cover).
func TestSendNowWithholdsTheEnterWhenAPromptOpensAfterThePressCheck(t *testing.T) {
	stuckGate(t, time.Hour, time.Hour)
	name := "claude-sendnow-lateprompt"
	term := &stuckTerm{screen: noBox}
	SetNeedsInputFunc(func(context.Context, string, string, string) bool { return true })
	t.Cleanup(func() { DropHeld(name, "test done"); waitGateIdle(t) })

	d, err := DeliverAutomated(context.Background(), pasteSend(term, name, "[board] QA: please look at #16", "board message", false))
	require.NoError(t, err)
	require.Equal(t, Held, d)
	time.Sleep(60 * time.Millisecond)

	var mu sync.Mutex
	reads := 0
	term.mu.Lock()
	term.onScreen = func() {
		mu.Lock()
		reads++
		n := reads
		mu.Unlock()
		if n == 2 { // read 1 is the press's check, 2 the forced paste's own look; the next one, before the Enter, finds the menu
			term.set(permissionMenu, false)
		}
	}
	term.mu.Unlock()
	res, err := SendHeldNow(context.Background(), name, "")
	require.NoError(t, err)
	assert.Zero(t, res.Sent)
	assert.Equal(t, 1, res.Again, "its Enter was withheld")
	pasted, enters := term.got()
	assert.Len(t, pasted, 1)
	assert.Zero(t, enters, "no Enter into a prompt")
	term.mu.Lock()
	term.onScreen = nil
	term.mu.Unlock()
}
