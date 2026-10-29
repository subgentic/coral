package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/typedcensus"
)

// The census of every notice this package types into an agent's terminal (goal #7, #378): each one, with plain labels and with
// typedcensus.Hostile in every label, starts with a fixed opener, gains nothing a shell acts on from its labels, and passes PowerShell's
// own parser with no command but the opener. A new typed notice belongs here.
func TestTypedNoticeCensus(t *testing.T) {
	h := typedcensus.Hostile
	cases := []typedcensus.Case{
		{"task completed", typedCompletedNotice(12, "Backend Dev", "success"), typedCompletedNotice(12, h, h)},
		{"task stalled", typedStalledNotice(12, "Fix the build", 9, "Old plan", "success"), typedStalledNotice(12, h, 9, h, h)},
		{"task reminder, waiting", typedTaskReminder(12, "Fix the build", "pending", false), typedTaskReminder(12, h, "pending", false)},
		{"task reminder, waiting behind another", typedTaskReminder(12, "Fix the build", "pending", true), typedTaskReminder(12, h, "pending", true)},
		{"task reminder, in progress", typedTaskReminder(12, "Fix the build", "in_progress", false), typedTaskReminder(12, h, "in_progress", false)},
		{"periodic task reminder", typedPeriodicReminder(12, "Fix the build"), typedPeriodicReminder(12, h)},
		{"board reminder", typedBoardReminder("check the queue"), typedBoardReminder(h)},
		{"message wait resolved", typedMessageWaitResolved("Lead Developer", "b-team"), typedMessageWaitResolved(h, h)},
		{"task wait resolved", typedTaskWaitResolved(12, "Fix the build", "completed"), typedTaskWaitResolved(12, h, h)},
		{"personal task", claimPrompt(&store.AgentTask{ID: 4, Title: "Fix the build"}), claimPrompt(&store.AgentTask{ID: 4, Title: h})},
		{"task available", taskClaimNudge(12), taskClaimNudge(12)},
		{"tasks available", taskNudge, taskNudge},
		{"artifact reminder", claudeArtifactNudgeText, claudeArtifactNudgeText},
		{"agent UI action", uiActionPrompt(7, "panel-1", 3), uiActionPrompt(7, "panel-1", 3)},
	}
	typedcensus.Run(t, cases)
}

// A completion's typed notice names the task, who completed it and the outcome, and says where the message is: the message itself, which
// the worker wrote, is never typed (goal #7, the Orchestrator's decision).
func TestTheCompletionNoticeCarriesNoMessage(t *testing.T) {
	got := typedCompletedNotice(12, "Backend Dev (approved by Security Reviewer)", "failed")
	assert.Equal(t, "[Task #12 completed by Backend Dev approved by Security Reviewer] Outcome: failed. Run 'coral-board task detail 12' to see the message.", got)
	assert.Equal(t, "reported", typedOutcome("anything else"), "an outcome is one of the fixed words")
	assert.Equal(t, "success", typedOutcome(""))
	assert.Equal(t, "[Wait resolved] Lead Developer posted on b-team. Run 'coral-board read' to see the message.", typedMessageWaitResolved("Lead Developer", "b-team"), "no preview")
}
