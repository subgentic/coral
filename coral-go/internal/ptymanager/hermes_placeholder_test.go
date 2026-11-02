package ptymanager

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #11936: Hermes shows a rotating hint in its empty input box (all eleven, from its locales/en.yaml), and the draft check took each for a person's text ("you have a draft in the box"), so the first message was
// never typed. The hints are matched whole and exactly: anything a person typed that merely starts like one is still a draft.
func TestBoxPlaceholderKnowsHermesHints(t *testing.T) {
	for _, hint := range []string{
		"Ask anything, or type / for commands…",
		"Summarize what's in this folder",
		"Draft a reply to the last email in my inbox",
		"Plan a feature, then build it step by step",
		"Find and fix a failing test",
		"Research this topic and write me a brief",
		"What changed in this repo recently?",
		"Turn these notes into a to-do list",
		"Explain this error and how to fix it",
		"Set a reminder or schedule a recurring task",
		"Type / to browse commands, or Ctrl+P for the palette",
	} {
		assert.True(t, boxPlaceholder(hint), hint)
		assert.True(t, boxPlaceholder("  "+hint+"  "), "padded: "+hint)
	}
	for _, draft := range []string{
		"Explain this error and how to fix it in main.go",
		"Find and fix a failing test in the cart",
		"Summarize what's in this folder, then delete it",
		"explain this error",
		"Ask anything, or type / for commands… and more",
		"Ask anything",
	} {
		assert.False(t, boxPlaceholder(draft), "a person's text: "+draft)
	}
}
