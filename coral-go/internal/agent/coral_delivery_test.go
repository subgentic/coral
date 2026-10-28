package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #10046: a turn Coral typed into an agent (the unread-messages nudge, a task notice, the health check, a stop-hook block) is not what a person asked for. The transcript records it as a user
// turn, and a session's first prompt (and the goal made from its requests) took the nudge for the request.
func TestIsCoralDeliveryKnowsWhatCoralTypesIntoAnAgent(t *testing.T) {
	for _, text := range []string{
		"You have 1 unread message on the message board. Run 'coral-board read' to see them.",
		"You have 12 unread messages on the message board. Run 'coral-board read' to see them.",
		"you have 3 UNREAD MESSAGES on the message board",
		"  You have 1 unread message on the message board. Run 'coral-board read'.\n",
		"@QA Engineer You have 1 unread message on the message board. Run 'coral-board read' to see them.",
		"/plan You have 1 unread message on the message board.",
		"You have tasks available. Run 'coral-board task list'.",
		"You have a new task in Coral (#42: Fix the thing)",
		"[Task #12 (high) available] do it",
		"[New Task #9 (low)] @notify-all something",
		"@notify-all [New Task #9 (low)] something",
		"[Wait resolved] the commit landed",
		"[Coral health check] Team health check for x: 2 unread messages",
		"[Coral] No activity on #9841 for 20 minutes.",
		"[Coral UI panel request p-1] open the file",
		"Stop hook feedback:\nNew board messages",
		"<pasted_content id=\"1\">You have 2 unread messages on the message board. Run 'coral-board read' to see them.</pasted_content>",
	} {
		assert.True(t, IsCoralDelivery(text), text)
	}
	for _, text := range []string{
		"",
		"Build the dashboard",
		"Review the unread messages in my inbox and summarise them",
		"You have a great idea: use a map",
		"You have to fix the bug in main.go",
		"Please read [Task #12] and answer",
		"Message number 14",
		"What does the Stop hook do?",
		"I got: Stop hook feedback: new messages, why?",
		"<pasted_content id=\"1\">fix the failing test</pasted_content>",
	} {
		assert.False(t, IsCoralDelivery(text), text)
	}
}
