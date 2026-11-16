package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #17411: a restarted agent's start message ends with the restart note, after the action text that asks it to introduce itself, so the note has the last word.
func TestTheStartMessageEndsWithTheRestartNote(t *testing.T) {
	p := LaunchParams{BoardName: "team-a", Role: "Dev", RestartNote: "\n\nYou were restarted: do not post a new introduction."}
	msg := p.StartMessage()
	assert.True(t, strings.HasSuffix(msg, "do not post a new introduction."), msg)
	assert.Contains(t, msg, "Post one short introduction", "the action text is still there")
}
