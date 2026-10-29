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
