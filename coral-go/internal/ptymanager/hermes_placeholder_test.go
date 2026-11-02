package ptymanager

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #11936: Hermes shows a rotating hint in its empty input box (seen on v0.22.5 in the tester's run), and the draft check took each for a person's text ("you have a draft in the box"), so the first message was
// never typed. The hints are matched whole and exactly: anything a person typed that merely starts like one is still a draft.
func TestBoxPlaceholderKnowsHermesHints(t *testing.T) {
	for _, hint := range []string{
		"Explain this error and how to fix it",
		"Turn these notes into a to-do list",
		"Type / to browse commands, or Ctrl+P for the palette",
		"Summarize what's in this folder",
		"Find and fix a failing test",
	} {
		assert.True(t, boxPlaceholder(hint), hint)
		assert.True(t, boxPlaceholder("  "+hint+"  "), "padded: "+hint)
	}
	for _, draft := range []string{
		"Explain this error and how to fix it in main.go",
		"Find and fix a failing test in the cart",
		"Summarize what's in this folder, then delete it",
		"explain this error",
	} {
		assert.False(t, boxPlaceholder(draft), "a person's text: "+draft)
	}
}
