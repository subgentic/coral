package routes

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15410: a switch that makes Claude ask a follow-up in its terminal (a dialog the transcript never records) is not a bare "did not confirm". The stand-in agent shows the dialog after /model is typed.

const switchModelDialog = "\n Switch model?\n Your next response will be slower and use more tokens\n\n This conversation is cached for the current model. Switching to Sonnet 5.5 means the full history gets re-read on your next message.\n\n ❯ 1. Yes, switch to Sonnet 5.5\n   2. No, go back\n"

const otherDialog = "\n Use extended context?\n Sonnet 5.5 can take a 1M token window on this plan.\n\n ❯ 1. Yes, use 1M context\n   2. No, keep 200K\n   3. Ask me later\n"

func TestASwitchDialogTheSwitchImpliesIsAnsweredYesOnce(t *testing.T) {
	r := newSwitchRig(t, "claude")
	var mu sync.Mutex
	var keys []string
	r.term.onRaw = func(string) {
		mu.Lock()
		defer mu.Unlock()
		keys = append(keys, "x")
		r.term.setOutput(r.name, "") // the dialog closes
		r.localCommand(t, "/model", "claude-sonnet-5-5", "Set model to `Sonnet 5.5`")
	}
	_, _ = r.post(t, map[string]any{"model": "claude-sonnet-5-5"})
	r.waitTyped(t, "/model claude-sonnet-5-5")
	r.term.setOutput(r.name, switchModelDialog)
	sw := r.waitState(t, switchDone)
	assert.Empty(t, sw.Asking)
	mu.Lock()
	assert.Len(t, keys, 1, "Yes was sent once")
	mu.Unlock()
	assert.Equal(t, []string{"/model claude-sonnet-5-5"}, r.typed(), "the command was not typed again into the dialog")
	model, _ := r.storedModel(t)
	assert.Equal(t, "claude-sonnet-5-5", model)
}

func TestAnyOtherSwitchDialogIsAskedInTheChatAndTheWaitDoesNotRunOut(t *testing.T) {
	r := newSwitchRig(t, "claude")
	var raw int
	var mu sync.Mutex
	r.term.onRaw = func(string) { mu.Lock(); raw++; mu.Unlock() }
	_, _ = r.post(t, map[string]any{"model": "claude-sonnet-5-5"})
	r.waitTyped(t, "/model claude-sonnet-5-5")
	r.term.setOutput(r.name, otherDialog)
	require.Eventually(t, func() bool {
		sw := r.state(t)
		return sw != nil && strings.Contains(sw.Asking, "Use extended context?")
	}, 2*time.Second, 5*time.Millisecond)
	assert.True(t, r.h.hints.mayBeOpen(r.sid), "the chat reads the screen for its card")
	time.Sleep(900 * time.Millisecond) // sleep-ok: longer than the shortened confirm wait (400 ms) twice over: an open dialog does not end the switch
	sw := r.state(t)
	require.NotNil(t, sw)
	assert.Equal(t, switchPending, sw.State, "still waiting for the person's answer, not failed: %+v", sw)
	mu.Lock()
	assert.Zero(t, raw, "Coral answers nothing it was not asked")
	mu.Unlock()
	assert.Equal(t, []string{"/model claude-sonnet-5-5"}, r.typed(), "never typed again into the dialog")

	// the person answers in the chat: the dialog closes and Claude writes its entry
	r.term.setOutput(r.name, "")
	r.localCommand(t, "/model", "claude-sonnet-5-5", "Set model to `Sonnet 5.5`")
	sw = r.waitState(t, switchDone)
	assert.Empty(t, sw.Asking)
}
