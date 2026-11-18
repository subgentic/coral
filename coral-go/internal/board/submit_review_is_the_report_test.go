package board

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #19623: submit-review is the report: Coral posts the "in review" line itself, so an agent that posts a second "ready" message doubles
// the Orchestrator's unread for one event. The Task queue guidance and the agent doc both say so.
func TestSubmitReviewIsTheReportAndAgentsAreToldNotToPostASecond(t *testing.T) {
	assert.Contains(t, taskQueueInstructions, "do not also post a ready message", "the Task queue guidance")
	doc, err := os.ReadFile("../../agent_docs/board.md")
	if assert.NoError(t, err) {
		assert.True(t, strings.Contains(string(doc), "do not also post a ready message"), "agent_docs/board.md, Reviewing a task")
	}
}
