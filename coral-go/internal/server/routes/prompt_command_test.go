package routes

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// The layout is the real one (the Beta Tester's run 2: every one of 16 real Bash prompts has ONE line of Claude's own under the closing rule, then the question).
// #14173 (the Beta Tester): a long command showed only its last lines, because the prompt's context was three lines. A permission prompt draws its request between two dashed rules; the whole block is the target.
func claudeBashScreen(command string) string {
	rule := strings.Repeat("╌", 110)
	return "⏺ Bash(something)\n  ⎿  Waiting…\n\n" + strings.Repeat("─", 110) + "\n Bash command\n Run a long thing\n" + rule + "\n" + command + "\n" + rule + "\n This command requires approval\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n"
}

func TestPermissionTarget_IsTheWholeBlockBetweenTheRules(t *testing.T) {
	var lines []string
	for i := 1; i <= 14; i++ {
		lines = append(lines, fmt.Sprintf(" step%02d --flag=%d", i, i))
	}
	s, ok := parsePromptScreen(claudeBashScreen(strings.Join(lines, "\n")))
	require.True(t, ok)
	assert.False(t, s.OnlyReject)
	for i := 1; i <= 14; i++ {
		assert.Contains(t, s.Target, fmt.Sprintf("step%02d --flag=%d", i, i), "line %d of the command is in the target", i)
	}
	assert.NotContains(t, s.Target, "╌", "the rules are not part of the command")
	assert.Equal(t, 14, len(strings.Split(s.Target, "\n")))

	one, ok := parsePromptScreen(claudeBashScreen(" touch probe.txt"))
	require.True(t, ok)
	assert.Equal(t, "touch probe.txt", one.Target)
	assert.Equal(t, "This command requires approval", one.TargetNote, "Claude's own line under the request is its note, not part of the command")
	assert.False(t, one.OnlyReject)

	// the ask is still told from the next one by its last lines: the same command with another first line is the same ask (context is unchanged), another last line is another ask
	other := strings.Replace(strings.Join(lines, "\n"), "step14 --flag=14", "step14 --flag=99", 1)
	s2, _ := parsePromptScreen(claudeBashScreen(other))
	assert.NotEqual(t, s.AskID, s2.AskID)

	// a screen with no dashed rules keeps the old three lines and a Target as before
	plain, ok := parsePromptScreen("some output\nmore output\nrun it?\n ❯ 1. Yes\n   2. No\n")
	require.True(t, ok)
	assert.Empty(t, plain.command)
}

func TestPermissionTarget_AHiddenCharacterInAnEarlyLineIsJudged(t *testing.T) {
	cmd := " echo safe\n echo \u202eevil\n echo one\n echo two\n echo three"
	s, ok := parsePromptScreen(claudeBashScreen(cmd))
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "a hidden character four lines up was never judged before; the whole block is now")
}

func TestPermissionTarget_TooLongIsOnlyReject(t *testing.T) {
	big := strings.Repeat(" echo "+strings.Repeat("x", 80)+"\n", 60)
	s, ok := parsePromptScreen(claudeBashScreen(strings.TrimRight(big, "\n")))
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "a request longer than the card shows can only be rejected")
}

// Security's SHOULD on #14173: a closing dashed rule with no opening rule in reach is a request that cannot be read whole: only Reject.
func TestPermissionTarget_NoOpeningRuleIsOnlyReject(t *testing.T) {
	rule := strings.Repeat("╌", 110)
	screen := "⏺ Bash(x)\n" + strings.Repeat(" more output\n", 3) + " touch a\n" + rule + "\n This command requires approval\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"
	s, ok := parsePromptScreen(screen)
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "the opening rule is not on the screen")
	assert.Contains(t, s.Note, "top of this request")
}

// A real prompt carries one line of Claude's own under the request; up to twelve lines of text are allowed there, more than that is not this layout (the screen keeps the old three-line context).
func TestPermissionTarget_DescriptionLines(t *testing.T) {
	rule := strings.Repeat("╌", 110)
	mk := func(desc string) string {
		return strings.Repeat("─", 110) + "\n Bash command\n" + rule + "\n touch a\n" + rule + "\n" + desc + "\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"
	}
	s, ok := parsePromptScreen(mk(" A variable in this command can't be checked before it runs"))
	require.True(t, ok)
	assert.Equal(t, "touch a", s.Target)
	assert.Equal(t, "A variable in this command can't be checked before it runs", s.TargetNote)
	three, ok := parsePromptScreen(mk(" one\n two\n three"))
	require.True(t, ok)
	assert.Equal(t, "touch a", three.Target)
	four, ok := parsePromptScreen(mk(" one\n two\n three\n four"))
	require.True(t, ok)
	assert.Equal(t, "touch a", four.Target, "four lines under the rule is still the request block")
	many, ok := parsePromptScreen(mk(strings.Repeat(" more\n", 13)))
	require.True(t, ok)
	assert.Empty(t, many.command, "thirteen lines under the rule is not this layout")
	assert.True(t, many.OnlyReject, "a real dialog with a tail of 13 lines under its closing rule fails closed: Reject only (#14271)")
	assert.Contains(t, many.Note, "top of this request")
}

// A REAL long Bash prompt (Beta Tester's run 2, Claude Code 2.1.314, paths and ids replaced, from a raw terminal log whose spacing is lost): 17 screen lines, about 1100 characters, Claude's own line under the closing rule.
func TestPermissionTarget_RealLongCapture(t *testing.T) {
	b, err := os.ReadFile("testdata/claude_bash_long_real.txt")
	require.NoError(t, err)
	s, ok := parsePromptScreen(string(b))
	require.True(t, ok)
	assert.False(t, s.OnlyReject, "a 1.1 KB request is under the card's limit")
	assert.GreaterOrEqual(t, len(strings.Split(s.Target, "\n")), 15, "every line of the real command is in the target")
	assert.Contains(t, s.Target, "mktemp")
	assert.Contains(t, s.Target, "curl")
	assert.NotContains(t, s.Target, "╌")
	assert.NotEmpty(t, s.TargetNote, "Claude's own line under the request is its note")
	assert.NotContains(t, s.Target, s.TargetNote)
	assert.Len(t, s.Options, 3)
}

// Security's SHOULDs on #14173: a program's own rules above a prompt with no Claude dialog header give no command, and another agent's screen never gives one.
func TestPermissionTarget_NeedsClaudeDialogAndSession(t *testing.T) {
	rule := strings.Repeat("╌", 110)
	forged := "some program output\n" + rule + "\n echo hello\n" + rule + "\n Fine.\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"
	s, ok := parsePromptScreen(forged)
	require.True(t, ok)
	assert.Empty(t, s.command, "rules with no dialog header above them are not Claude's request block")
	assert.True(t, s.OnlyReject, "two rules and no header: Reject only, never the old three lines with an Allow")
	assert.Contains(t, s.Note, "top of this request")

	real := claudeBashScreen(" touch a\n echo b")
	c, ok := parseAgentScreen(at.Claude, real)
	require.True(t, ok)
	assert.Equal(t, "touch a\necho b", c.Target)
	for _, agent := range []string{at.Codex, at.Agy, at.Gemini, at.Terminal, at.Pi, "", "unknown"} {
		o, ok := parseAgentScreen(agent, real)
		if !ok {
			continue
		}
		assert.Empty(t, o.command, "no request block for %q", agent)
		assert.Empty(t, o.TargetNote, "no note for %q", agent)
		assert.False(t, o.commandOpenMissing)
	}
	for _, header := range []string{"Edit file", "Create file", "Bash command"} {
		h, ok := parsePromptScreen(strings.Replace(real, "Bash command", header, 1))
		require.True(t, ok)
		assert.NotEmpty(t, h.command, header)
	}
	other, ok := parsePromptScreen(strings.Replace(real, "Bash command", "Something else", 1))
	require.True(t, ok)
	assert.Empty(t, other.command, "a header that names no command or file is not the request dialog")
}

// Security's SHOULD on #14173 round 4: the agent's own description under the header can run to many lines; it must not push the header out of reach and turn the prompt back into one with an Allow.
func TestPermissionTarget_LongDescriptionStillFindsTheHeader(t *testing.T) {
	rule := strings.Repeat("╌", 110)
	for _, n := range []int{1, 6, 12, 20} {
		var desc []string
		for i := 0; i < n; i++ {
			desc = append(desc, fmt.Sprintf(" description line %d of the agent", i+1))
		}
		screen := strings.Repeat("─", 110) + "\n Bash command\n" + strings.Join(desc, "\n") + "\n" + rule + "\n touch a\n echo b\n" + rule + "\n This command requires approval\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"
		s, ok := parsePromptScreen(screen)
		require.True(t, ok, n)
		assert.Equal(t, "touch a\necho b", s.Target, "a %d-line description still finds the header", n)
		assert.False(t, s.OnlyReject, n)
	}
	far := strings.Repeat("─", 110) + "\n Bash command\n" + strings.Repeat(" filler\n", 40) + rule + "\n touch a\n" + rule + "\n x\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
	s, ok := parsePromptScreen(far)
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "a header that is out of reach is Reject only, not an Allow on a command whose top was never read")
}

// #14271: a REAL Claude capture whose description is made long (13 and 40 lines) is Reject-only; a screen with no dialog above the tail keeps the old behaviour.
func TestPermissionTarget_RealCaptureWithALongTailIsRejectOnly(t *testing.T) {
	b, err := os.ReadFile("testdata/claude_bash_long_real.txt")
	require.NoError(t, err)
	real := string(b)
	i := strings.Index(real, "\n\n Do you want to proceed?") // the tail goes under Claude's own line, before the blank line that sets the question apart (a tail glued to the question line is part of the question)
	require.Greater(t, i, 0)
	for _, n := range []int{13, 40} {
		tail := strings.Repeat("\n an agent-written line under the rule", n)
		s, ok := parsePromptScreen(real[:i] + tail + real[i:])
		require.True(t, ok, n)
		assert.True(t, s.OnlyReject, "a %d-line tail under a real request", n)
		assert.Empty(t, s.command, n)
	}
	s, ok := parsePromptScreen(real)
	require.True(t, ok)
	assert.False(t, s.OnlyReject, "the capture itself is unchanged")
	// no dialog above the tail: the old context, as before
	bare := "output\n" + strings.Repeat("text line\n", 20) + " Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
	p, ok := parsePromptScreen(bare)
	require.True(t, ok)
	assert.False(t, p.OnlyReject)
}
