package routes

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/terminalinput"
)

// #14106: a session has a prompt open while the agent's own request is open or the dialog watcher saw a prompt on its screen; a person's input then answers it and is not talk to the agent.
func TestAPromptIsOpenWhileARequestIsOpenOrADialogIsOnTheScreen(t *testing.T) {
	r := newHoldRig(t, true)
	sid := strings.ToLower(r.sid)
	assert.False(t, r.h.PromptOpenFor(sid), "nothing open")

	r.requestFor("Wants to run: go test ./...")
	assert.True(t, r.h.PromptOpenFor(sid), "the agent's own request is open")
	r.answered()
	assert.False(t, r.h.PromptOpenFor(sid), "answered: closed")

	r.h.dialogs.mu.Lock()
	r.h.dialogs.seen = map[string]*dialogSeen{sid: {first: time.Now(), passes: 1}}
	r.h.dialogs.mu.Unlock()
	assert.True(t, r.h.PromptOpenFor(sid), "a prompt the watcher saw on the screen (a trust dialog has no hook)")
	r.h.forgetDialog(sid)
	assert.False(t, r.h.PromptOpenFor(sid))
	assert.False(t, r.h.PromptOpenFor("no-such-session"))
}

// End to end through the terminal input: the person's "1" at an open permission request is not talk, so the agent's notices are not held; the same key with no prompt is.
func TestAPersonsAnswerToAnOpenRequestIsNotTalkToTheAgent(t *testing.T) {
	r := newHoldRig(t, true)
	sid := strings.ToLower(r.sid)
	terminalinput.SetPromptOpenCheck(r.h.PromptOpenFor)
	t.Cleanup(func() { terminalinput.SetPromptOpenCheck(nil) })

	r.requestFor("Wants to run: ls")
	terminalinput.Record(terminalinput.Person, "claude-"+sid+":0.0", terminalinput.Keys, "1")
	assert.False(t, terminalinput.PersonTalkedWithin(sid, time.Minute), "an answer to the open request is not talk")
	assert.True(t, terminalinput.PersonTypedWithin(sid, time.Minute), "the person is at the keyboard")

}
