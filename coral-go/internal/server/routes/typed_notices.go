package routes

import (
	"fmt"

	"github.com/subgentic/coral/internal/board"
)

// The notices this package TYPES into an agent's terminal (goal #7, #378). That terminal may not be the agent's CLI: an exited agent
// leaves a shell there, and a person can start another one (cmd, bash, PowerShell), where a typed line runs as a command. So a typed
// notice:
//   - starts with one of board.TypedOpeners, never with a label (in cmd.exe the first word runs; in PowerShell a bare first word is a command);
//   - carries no long text someone else wrote (a completion message, a message preview): it names the id, and coral-board shows the text;
//   - puts every short label it does carry (a task title, a subscriber, a board) through board.TypedLabel.
// The board posts with the same news keep their full text: they are stored and shown, not typed. typed_notices_test.go is the census.

// typedCompletedNotice tells an orchestrator that a task was completed, and how to read what the worker wrote.
func typedCompletedNotice(taskID int64, by, outcome string) string {
	return fmt.Sprintf("[Task #%d completed by %s] Outcome: %s. Run 'coral-board task detail %d' to see the message.", taskID, board.TypedLabel(by), typedOutcome(outcome), taskID)
}

// typedOutcome is a completion's outcome as one of the fixed words a task can end with; anything else is "reported".
func typedOutcome(outcome string) string {
	switch outcome {
	case "success", "failed":
		return outcome
	case "":
		return "success" // a completion with no outcome is a success (completion_review.go)
	}
	return "reported"
}

// typedStalledNotice tells an orchestrator that a task can no longer start because a task it depends on was cancelled.
func typedStalledNotice(taskID int64, title string, cancelledID int64, cancelledTitle, condition string) string {
	return fmt.Sprintf("[Task #%d stalled] %s depends on cancelled task #%d, %s. Its %s dependency cannot be satisfied: update or rewire the task.",
		taskID, board.TypedLabel(title), cancelledID, board.TypedLabel(cancelledTitle), board.TypedLabel(condition))
}

// typedTaskReminder is the nudge for a task assigned to the agent: still waiting (and whether another task comes first), or in progress.
func typedTaskReminder(taskID int64, title, status string, hasActive bool) string {
	t := board.TypedLabel(title)
	switch {
	case status == "in_progress":
		return fmt.Sprintf("[Task #%d reminder] %s - still in progress. Continue it, or run 'coral-board task complete %d' when it's done.", taskID, t, taskID)
	case hasActive:
		return fmt.Sprintf("[Task #%d reminder] %s - assigned to you and waiting; claim it with 'coral-board task claim %d' when your current task is done.", taskID, t, taskID)
	}
	return fmt.Sprintf("[Task #%d reminder] %s - assigned to you and waiting. Run 'coral-board task claim %d' to start.", taskID, t, taskID)
}

// typedPeriodicReminder is the periodic reminder of the task an agent has in progress.
func typedPeriodicReminder(taskID int64, title string) string {
	return fmt.Sprintf("[Task #%d reminder] %s - periodic reminder; run 'coral-board task current' or 'coral-board task claim'.", taskID, board.TypedLabel(title))
}

// typedBoardReminder is a reminder someone set for a subscriber: its words, as a label.
func typedBoardReminder(message string) string {
	return "[Coral reminder] " + board.TypedLabel(message)
}

// typedMessageWaitResolved tells an agent that the message it waited for has come. The message itself is read on the board.
func typedMessageWaitResolved(sender, project string) string {
	return fmt.Sprintf("[Wait resolved] %s posted on %s. Run 'coral-board read' to see the message.", board.TypedLabel(sender), board.TypedLabel(project))
}

// typedTaskWaitResolved tells an agent that the task it waited for has moved on.
func typedTaskWaitResolved(taskID int64, title, event string) string {
	return fmt.Sprintf("[Wait resolved] Task #%d, %s, is now %s. Run 'coral-board task detail %d' to review.", taskID, board.TypedLabel(title), board.TypedLabel(event), taskID)
}

// typedClaimPrompt is what an agent is told when the operator gives it a task: short, naming the task and the commands to claim and finish it.
func typedClaimPrompt(taskID int64, title string) string {
	return fmt.Sprintf("You have a new task in Coral, #%d: %s. Claim it with 'coral-agent task claim' to see the details, then run 'coral-agent task complete %d' when it's done.", taskID, board.TypedLabel(title), taskID)
}
