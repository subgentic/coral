package ptymanager

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15066 item 4: when Coral's /compact was typed and its Enter did not take, the next send presses that Enter and types nothing; the caller is told which text it was, so a command that is that very text
// counts as sent (it was submitted) instead of being typed a second time at the pass after.
func TestAPressedLeftoverEnterTellsWhichTextItWas(t *testing.T) {
	n := "claude-t-leftover-said"
	defer ForgetSession(n)
	a := &fakeAgent{screen: idleInputBox}
	assert.Equal(t, Sent, deliver(t, a, n, "Read the board"))

	a.show(claudeMonitorWithText) // its Enter did not take: the box still holds exactly that text
	var told []string
	in := a.input(n, "Read the board", false)
	in.OnLeftoverSubmitted = func(text string) { told = append(told, text) }
	d, err := DeliverAutomated(context.Background(), in)
	require.NoError(t, err)
	assert.Equal(t, Skipped, d, "nothing new was typed")
	assert.Equal(t, 1, a.enters, "the earlier text's Enter is pressed")
	require.Len(t, told, 1, "and the caller is told")
	assert.True(t, SameTyped(told[0], "Read the board"), "which text it was: "+strings.Join(told, "|"))
	assert.False(t, SameTyped(told[0], "You have 2 unread messages"))
}
