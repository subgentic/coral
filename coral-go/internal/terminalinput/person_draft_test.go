package terminalinput

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// A person's unsent text: set by what they type, cleared by Enter, Ctrl+C, Ctrl+U or Esc (not Backspace), forgotten after an hour; only for a person's input, by session.
func TestAPersonsUnsentTextIsKnownUntilTheySubmitOrClearIt(t *testing.T) {
	const sid = "aaaaaaaa-0425-4000-8000-00000000d0f1"
	target := "claude-" + sid
	t.Cleanup(func() { personDraft.Delete(sid) })
	assert.False(t, PersonDraftPending(sid))

	RecordInput(Person, target, "half a thought")
	assert.True(t, PersonDraftPending(sid), "typed text")
	RecordInput(Person, target, "\x7f")
	assert.True(t, PersonDraftPending(sid), "Backspace leaves text on the line")
	RecordInput(Person, target, "\x1b[D")
	assert.True(t, PersonDraftPending(sid), "an arrow neither submits nor clears")
	for name, clear := range map[string]string{"Enter": "\r", "a bare line feed": "\n", "Ctrl+C": "\x03", "Ctrl+U": "\x15", "Esc": "\x1b"} {
		RecordInput(Person, target, "more")
		assert.True(t, PersonDraftPending(sid))
		RecordInput(Person, target, clear)
		assert.False(t, PersonDraftPending(sid), name+" clears it")
	}
	RecordInput(Person, target, "a line and its Enter\r")
	assert.False(t, PersonDraftPending(sid), "text submitted in the same write")

	RecordInput(Coral, target, "Coral's own notice")
	assert.False(t, PersonDraftPending(sid), "only a person's input counts")
	Record(Person, target+":0.0", Keys, "x")
	assert.True(t, PersonDraftPending(sid), "a character sent as a key, to a tmux pane of the session")

	personDraft.Store(sid, time.Now().Add(-personDraftFor-time.Minute).UnixNano())
	assert.False(t, PersonDraftPending(sid), "forgotten after an hour")
}
