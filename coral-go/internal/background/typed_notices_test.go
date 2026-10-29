package background

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/typedcensus"
)

// The census of every notice this package types into an agent's terminal (goal #7, #378), as the routes package has its own: with plain
// labels and with typedcensus.Hostile in every label, each starts with a fixed opener, gains nothing a shell acts on, and passes
// PowerShell's own parser. A new typed notice belongs here.
func TestTypedNoticeCensus(t *testing.T) {
	h := typedcensus.Hostile
	at := time.Date(2026, 10, 29, 9, 0, 0, 0, time.UTC)
	composed := "Since 08:00: 2 tasks completed. Waiting: Backend Dev on #12 (said \"" + h + "\")."
	cases := []typedcensus.Case{
		{"board nudge", nudgeText("b-team", 2, false), nudgeText(h, 2, false)},
		{"board nudge, health", nudgeText("b-team", 2, true), nudgeText(h, 2, true)},
		{"mention re-nudge", mentionRenudgeText("Lead Developer", 1, at), mentionRenudgeText(h, 1, at)},
		{"mention re-nudge, several", mentionRenudgeText("Lead Developer", 3, at), mentionRenudgeText(h, 3, at)},
		{"question reminder", askReminderText("Lead Developer", 20, 31), askReminderText(h, 20, 31)},
		{"claim nudge", claimNudgeText(12), claimNudgeText(12)},
		{"status nudge", statusNudgeText(12, 30), statusNudgeText(12, 30)},
		{"task reminder", taskReminderText(12, at), taskReminderText(12, at)},
		{"team health check", typedHealthCheck("Since 08:00: 2 tasks completed. Waiting: Backend Dev on #12."), typedHealthCheck(composed)},
		{"team health check, roster form", typedHealthCheck("[Coral health check] 08:00Z · 3 agents"), typedHealthCheck("[Coral health check] 08:00Z · " + h)},
		{"health line to a member", typedHealthLine("you have 2 tasks off the books"), typedHealthLine(h)},
	}
	typedcensus.Run(t, cases)
}

// The cross-board hint is by reference: the sender's board name, which that board chose, is never typed (goal #7).
func TestTheCrossBoardHintNamesNoBoard(t *testing.T) {
	b, err := os.ReadFile("notifier.go")
	require.NoError(t, err)
	src := string(b)
	assert.Contains(t, src, `is from another board; 'coral-board read' shows how to answer it.`)
	assert.NotContains(t, src, "m.ReplyWith)", "the reply line (CrossReplyLine) is shown by coral-board read, not typed")
	assert.True(t, strings.HasPrefix(typedHealthCheck("Since 08:00: fine."), "[Coral health check] Since 08:00: fine"), typedHealthCheck("Since 08:00: fine."))
}

// Every call in this package that types text into an agent's terminal, and where its text comes from (Security on goal #7). A new call
// fails here until its text comes from a census builder and it is listed.
func TestEveryTypedSenderIsInTheCensus(t *testing.T) {
	typedcensus.CheckSites(t, ".", []typedcensus.Site{
		{"agent_exited.go", `text, what, requireInputBox, mention, nil)`, 1, "deliverAutomated: forwards the text of the callers listed here"},
		{"board_health.go", `board.OneLine(text), "health check"`, 1, "the monitor's deliver: forwards typedHealthCheck and typedHealthLine"},
		{"board_health.go", `typedHealthCheck(`, 1, "census"},
		{"board_health_offbooks.go", `typedHealthLine(`, 1, "census"},
		{"health_limit.go", `deliver(ctx, a, key, text)`, 1, "sendUnlessBlocked: forwards the text of the callers listed here"},
		{"health_nudges.go", `board.OneLine(text), "health nudge"`, 1, "the nudges' deliver: forwards the builders below"},
		{"health_nudges.go", `claimNudgeText(`, 1, "census"},
		{"health_nudges.go", `statusNudgeText(`, 1, "census"},
		{"health_nudges.go", `mentionRenudgeText(`, 1, "census"},
		{"health_nudges.go", `askReminderText(`, 1, "census"},
		{"health_remind.go", `board.OneLine(text), "task reminder"`, 1, "the reminders' deliver: forwards taskReminderText"},
		{"health_remind.go", `taskReminderText(`, 1, "census"},
		{"launcher.go", `prompt, "initial prompt"`, 1, "exception: the launch's own prompt (the person's, or a scheduled job's), the agent's first input"},
		{"notifier.go", `text, what, requireInputBox, mention, wanted)`, 1, "deliverNudge: forwards nudgeText (census: board nudge)"},
		{"remote_poller.go", `board.OneLine(nudge), "remote board nudge"`, 1, "fixed text with a count, the same sentence as nudgeText's (census: board nudge)"},
	})
}
