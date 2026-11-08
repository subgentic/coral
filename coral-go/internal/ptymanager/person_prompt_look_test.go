package ptymanager

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

type lookTerm struct {
	screen string
	err    error
}

func (l lookTerm) AgentScreen(context.Context, string, string, string) (string, error) {
	return l.screen, l.err
}

// #14481 (QA's SHOULD on #14357): what PromptOpenOnScreen answers, pinned, because a held person's message is released on it. Only a prompt or menu on the screen is true. A screen that cannot be
// read, an empty one (a screen not yet drawn, or a cached one that does not have the prompt yet), a terminal with no screen to read, a draft in the box and an ordinary screen are all false: the
// look is FORCED, as DeliverNow's is (a person's send goes on unless a prompt is SEEN), so an unreadable screen never holds a message for good. A look that counted any skip reason as a prompt
// (the draft, the unreadable screen) fails here.
func TestPromptOpenOnScreenIsTrueOnlyForAPromptOnTheScreen(t *testing.T) {
	ctx := context.Background()
	open := func(term any, text string) bool {
		return PromptOpenOnScreen(ctx, term, "claude-x", "claude", "sid", text)
	}
	assert.True(t, open(lookTerm{screen: permissionMenu}, "hello"), "a permission menu on the screen")
	assert.False(t, open(lookTerm{screen: "", err: errors.New("no screen")}, "hello"), "a screen that cannot be read")
	assert.False(t, open(lookTerm{screen: "   \n  \n"}, "hello"), "an empty screen: the prompt is not drawn yet")
	assert.False(t, open(lookTerm{screen: "Just some output\n"}, "hello"), "an ordinary screen")
	assert.False(t, open(struct{}{}, "hello"), "a terminal with no screen to read")
	assert.False(t, open(lookTerm{screen: "Just some output\n\n> a draft the person is typing\n"}, "hello"), "a draft in the box is not a prompt")
}
