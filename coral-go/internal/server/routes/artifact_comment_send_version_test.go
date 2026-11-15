package routes

import (
	"strings"
	"testing"
)

// #17361 (walk 67): a comment on a file reaches the agent with the way to answer it with a fix: the next version of the same file, not a new file, and everything that changed said in the reply.
func TestACommentOnAFileTellsTheAgentToAnswerWithANewVersion(t *testing.T) {
	for _, author := range []string{"Someone", sendAuthorOperator} {
		msg := sendMessage("Dev", author, "coral://artifacts/"+strings.Repeat("a", 64), sendReplyCommand(strings.Repeat("a", 64), 7), "add a print button", "", nil)
		for _, want := range []string{"--new-version-of", "same name", "everything"} {
			if !strings.Contains(msg, want) {
				t.Errorf("author %q: the message does not say %q:\n%s", author, want, msg)
			}
		}
	}
	goal := sendMessageOf(sendOnGoal, "Dev", sendAuthorOperator, "goal #3", "x", "c", "", nil)
	if strings.Contains(goal, "--new-version-of") {
		t.Errorf("a comment on a goal has no file to version:\n%s", goal)
	}
}
