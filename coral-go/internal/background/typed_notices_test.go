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
		typedcensus.C("board nudge", nudgeText("b-team", 2, false), nudgeText(h, 2, false)),
		typedcensus.C("board nudge, health", nudgeText("b-team", 2, true), nudgeText(h, 2, true)),
		typedcensus.C("mention re-nudge", mentionRenudgeText("Lead Developer", 1, at), mentionRenudgeText(h, 1, at)),
		typedcensus.C("mention re-nudge, several", mentionRenudgeText("Lead Developer", 3, at), mentionRenudgeText(h, 3, at)),
		typedcensus.C("question reminder", askReminderText("Lead Developer", 20, 31), askReminderText(h, 20, 31)),
		typedcensus.C("claim nudge", claimNudgeText(12), claimNudgeText(12)),
		typedcensus.C("status nudge", statusNudgeText(12, 30), statusNudgeText(12, 30)),
		typedcensus.C("task reminder", taskReminderText(12, at), taskReminderText(12, at)),
		typedcensus.C("team health check", typedHealthCheck("Since 08:00: 2 tasks completed. Waiting: Backend Dev on #12."), typedHealthCheck(composed)),
		typedcensus.C("team health check, roster form", typedHealthCheck("[Coral health check] 08:00Z · 3 agents"), typedHealthCheck("[Coral health check] 08:00Z · "+h)),
		typedcensus.C("health line to a member", typedHealthLine("you have 2 tasks off the books"), typedHealthLine(h)),
		typedcensus.C("the monitor's deliver, a check", typedHealth("Since 08:00: fine."), typedHealth(composed)),
		typedcensus.C("the monitor's deliver, a member's line", typedHealth("[Coral health] 2 tasks off the books"), typedHealth("[Coral health] "+h)),
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
		typedcensus.S("agent_exited.go", `rt.SendInput(ctx, terminalinput.Coral, name, text)`, 1, "deliverAutomatedIfWanted's own send: types the text of its callers, listed here"),
		typedcensus.S("agent_exited.go", `text, what, requireInputBox, mention, nil)`, 1, "deliverAutomated: forwards the text of the callers listed here"),
		typedcensus.S("board_health.go", `typedHealth(text), "health check"`, 1, "the monitor's deliver: everything it types goes through typedHealth (census: team health check, health line)"),
		typedcensus.S("board_health.go", `"health-check:"+project, text)`, 1, "the check, through the monitor's deliver (typedHealth)"),
		typedcensus.S("board_health_offbooks.go", `"[Coral health] "+detail)`, 1, "a member's line, through the monitor's deliver (typedHealth)"),
		typedcensus.S("health_limit.go", `deliver(ctx, a, key, text)`, 1, "sendUnlessBlocked: forwards the text of the callers listed here"),
		typedcensus.S("health_nudges.go", `board.OneLine(text), "health nudge"`, 1, "the nudges' deliver: forwards the builders below"),
		typedcensus.S("health_nudges.go", `claimNudgeText(`, 1, "census"),
		typedcensus.S("health_nudges.go", `statusNudgeText(`, 1, "census"),
		typedcensus.S("health_nudges.go", `mentionRenudgeText(`, 1, "census"),
		typedcensus.S("health_nudges.go", `askReminderText(`, 1, "census"),
		typedcensus.S("health_remind.go", `board.OneLine(text), "task reminder"`, 1, "the reminders' deliver: forwards taskReminderText"),
		typedcensus.S("health_remind.go", `taskReminderText(`, 1, "census"),
		typedcensus.S("launcher.go", `prompt, "initial prompt"`, 1, "exception: the launch's own prompt (the person's, or a scheduled job's), the agent's first input"),
		typedcensus.S("notifier.go", `deliver()`, 2, "the nudge's own closure: types nudgeText and the cross-board hint (census: board nudge)"),
		typedcensus.S("notifier.go", `text, what, requireInputBox, mention, wanted)`, 1, "deliverNudge: forwards nudgeText (census: board nudge)"),
		typedcensus.S("remote_poller.go", `board.OneLine(nudge), "remote board nudge"`, 1, "fixed text with a count, the same sentence as nudgeText's (census: board nudge)"),
	})
}
