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
		typedcensus.C("task completed", typedCompletedNotice(12, "Backend Dev", "success"), typedCompletedNotice(12, h, h)),
		typedcensus.C("task stalled", typedStalledNotice(12, "Fix the build", 9, "Old plan", "success"), typedStalledNotice(12, h, 9, h, h)),
		typedcensus.C("task reminder, waiting", typedTaskReminder(12, "Fix the build", "pending", false), typedTaskReminder(12, h, "pending", false)),
		typedcensus.C("task reminder, waiting behind another", typedTaskReminder(12, "Fix the build", "pending", true), typedTaskReminder(12, h, "pending", true)),
		typedcensus.C("task reminder, in progress", typedTaskReminder(12, "Fix the build", "in_progress", false), typedTaskReminder(12, h, "in_progress", false)),
		typedcensus.C("periodic task reminder", typedPeriodicReminder(12, "Fix the build"), typedPeriodicReminder(12, h)),
		typedcensus.C("board reminder", typedBoardReminder("check the queue"), typedBoardReminder(h)),
		typedcensus.C("message wait resolved", typedMessageWaitResolved("Lead Developer", "b-team"), typedMessageWaitResolved(h, h)),
		typedcensus.C("task wait resolved", typedTaskWaitResolved(12, "Fix the build", "completed"), typedTaskWaitResolved(12, h, h)),
		typedcensus.C("personal task", claimPrompt(&store.AgentTask{ID: 4, Title: "Fix the build"}), claimPrompt(&store.AgentTask{ID: 4, Title: h})),
		typedcensus.C("task available", taskClaimNudge(12), taskClaimNudge(12)),
		typedcensus.C("tasks available", taskNudge, taskNudge),
		typedcensus.C("artifact reminder", claudeArtifactNudgeText, claudeArtifactNudgeText),
		typedcensus.C("agent UI action", uiActionPrompt(7, "panel-1", 3), uiActionPrompt(7, "panel-1", 3)),
		typedcensus.C("review pool", reviewPoolNudge, reviewPoolNudge),
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

// Every call in this package that types text into an agent's terminal, and where its text comes from (Security on goal #7: the census
// above must not miss a new sender). A new call fails here until its text comes from a census builder and it is listed.
func TestEveryTypedSenderIsInTheCensus(t *testing.T) {
	typedcensus.CheckSites(t, ".", []typedcensus.Site{
		typedcensus.S("agent_exited.go", `board.OneLine(text), "board message"`, 1, "sendAutomated: forwards the text of the callers listed here"),
		typedcensus.S("agent_tasks.go", `prompt, "task notification"`, 1, "claimPrompt (census: personal task)"),
		typedcensus.S("agent_ui.go", `prompt, "agent UI action"`, 1, "uiActionPrompt (census)"),
		typedcensus.S("agent_ui_request.go", `notification, ls.AgentType`, 1, "exception: the person's own request, typed as their own send is (the Orchestrator, goal #7)"),
		typedcensus.S("auto_review.go", `taskClaimNudge(`, 1, "census: task available"),
		typedcensus.S("board_notifications.go", `notification); err`, 1, "typedCompletedNotice (census)"),
		typedcensus.S("board_notifications.go", `typed); err`, 1, "typedStalledNotice (census)"),
		typedcensus.S("board_notifications.go", `sub.SessionName, text); err`, 1, "sendTaskNudge: forwards the text of the callers listed here"),
		typedcensus.S("board_notifications.go", `assignee, text); err`, 1, "typedTaskReminder (census)"),
		typedcensus.S("board_notifications.go", `subscriberID, text); err`, 1, "taskNudge or taskClaimNudge (census)"),
		typedcensus.S("board_notifications.go", `typedPeriodicReminder(`, 1, "census"),
		typedcensus.S("board_reminders.go", `typedBoardReminder(`, 1, "census"),
		typedcensus.S("board_task_create.go", `taskClaimNudge(`, 1, "census"),
		typedcensus.S("board_task_create.go", `taskNudge)`, 1, "census: tasks available"),
		typedcensus.S("board_task_edit.go", `taskClaimNudge(`, 4, "census"),
		typedcensus.S("board_task_flow.go", `taskClaimNudge(`, 1, "census"),
		typedcensus.S("board_waits.go", `nudge); err`, 2, "typedMessageWaitResolved, typedTaskWaitResolved (census)"),
		typedcensus.S("claude_artifact_nudge.go", `text, what)`, 1, "the nudger's deliver: forwards claudeArtifactNudgeText"),
		typedcensus.S("claude_artifact_nudge.go", `claudeArtifactNudgeText`, 1, "census: artifact reminder"),
		typedcensus.S("review_pool.go", `reviewPoolNudge`, 1, "census"),
	})
}
