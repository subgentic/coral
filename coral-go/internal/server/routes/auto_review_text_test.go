package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/board"
)

// #20496: auto_delegate.text: the short line to the Orchestrator names who was asked and leaves out the reason and the way to change them; any other level says all of it.
func TestAutoDelegateLineReadsItsTextLevel(t *testing.T) {
	assert.Len(t, autoDelegateArgs(board.RuleRoute{Text: board.TextShort}, 5, "A (#6)", "pool", "Orchestrator"), 3)
	assert.Len(t, autoDelegateArgs(board.RuleRoute{}, 5, "A (#6)", "pool", "Orchestrator"), 5)
	assert.Len(t, autoDelegateArgs(board.RuleRoute{Text: board.TextLong}, 5, "A (#6)", "pool", "Orchestrator"), 5)
}
