package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #14575 (Beta run 3): a Bash request of about 90 lines showed 'The top of this request is not on the screen ... It can only be rejected here', and nobody could allow it, because the prompt was read from the LAST 80 lines of the
// pane and the request's opening dashed rule was farther up. The parser walks up to commandMaxLines (400) for it, so the window is the limit: when the first read misses the opening rule, the pane is read again deeper, and the
// same checks (the dialog header, the 4000-byte limit, hidden characters) then judge what is found. A request whose top is still not there stays Reject only.

// linesTerminal answers CaptureOutput as tmux does: the last `lines` lines of the pane (history included).
type linesTerminal struct {
	*mockSessionTerminal
	pane  string
	asked []int
}

func (l *linesTerminal) CaptureOutput(_ context.Context, _ string, lines int, _, _ string) (string, error) {
	l.asked = append(l.asked, lines)
	all := strings.Split(l.pane, "\n")
	if lines < len(all) {
		all = all[len(all)-lines:]
	}
	return strings.Join(all, "\n"), nil
}

// screenAndScrollbackTerminal is a terminal whose prompt read is the screen as drawn (the PTY backend: RenderedScreen, 50 rows) while CaptureOutput(lines) gives the rows that scrolled off above it too, as vtscreen.RenderScrollback does.
type screenAndScrollbackTerminal struct{ *linesTerminal }

func (p *screenAndScrollbackTerminal) RenderedScreen(_ context.Context, _, _, _ string) (string, error) {
	all := strings.Split(p.pane, "\n")
	if len(all) > 50 {
		all = all[len(all)-50:]
	}
	return strings.Join(all, "\n"), nil
}

func deepRig(pane string) (*SessionsHandler, *linesTerminal) {
	lt := &linesTerminal{mockSessionTerminal: newMockTerminal(), pane: pane}
	return &SessionsHandler{terminal: lt}, lt
}

func longCommand(n int) string {
	var b []string
	for i := 1; i <= n; i++ {
		b = append(b, fmt.Sprintf(" echo line%03d >> /tmp/probe.txt", i))
	}
	return strings.Join(b, "\n")
}

func TestARequestWhoseTopIsAboveTheFirstWindowIsReadWhole(t *testing.T) {
	pane := strings.Repeat("older output\n", 30) + claudeBashScreen(longCommand(95)) // about 95 lines of command: over the 80-line window, under 4000 bytes
	h, lt := deepRig(pane)
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	assert.False(t, s.OnlyReject, "the top is in the pane's history: the request is read whole and the person can allow it: %s", s.Note)
	assert.Contains(t, s.Target, "line001", "the first line of the command is in what the card shows")
	assert.Contains(t, s.Target, "line095", "and the last")
	assert.Equal(t, []int{80, deepPromptCaptureLines}, lt.asked, "the pane is read again, deeper, only because the first read missed the top")
}

func TestARequestThatFitsTheFirstWindowIsReadOnce(t *testing.T) {
	h, lt := deepRig(claudeBashScreen(longCommand(5)))
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	assert.False(t, s.OnlyReject)
	assert.Equal(t, []int{80}, lt.asked, "no deeper read when the top was found")
}

func TestARequestWhoseTopIsNowhereInThePaneStaysRejectOnly(t *testing.T) {
	rule := strings.Repeat("╌", 110)
	pane := strings.Repeat(" more output\n", 200) + longCommand(10) + "\n" + rule + "\n This command requires approval\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"
	h, _ := deepRig(pane)
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "a request that was never shown whole can only be rejected, however deep the read")
	assert.Contains(t, s.Note, "top of this request")
}

func TestADeeperReadStillJudgesTheRequestByTheSameLimits(t *testing.T) {
	big := strings.Repeat(" echo "+strings.Repeat("x", 80)+"\n", 100) // 100 lines, over 4000 bytes
	h, _ := deepRig(claudeBashScreen(strings.TrimRight(big, "\n")))
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "found whole but over the byte limit: still Reject only")
	hidden := strings.Replace(longCommand(95), "line010", "line\u202e010", 1)
	h2, _ := deepRig(claudeBashScreen(hidden))
	s2, ok2, _, err2 := h2.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err2)
	require.True(t, ok2)
	assert.True(t, s2.OnlyReject, "a hidden character in a line the first window never saw is judged too")
}

func TestADeeperReadIsForClaudeOnly(t *testing.T) {
	h, lt := deepRig(strings.Repeat("older output\n", 30) + claudeBashScreen(longCommand(95)))
	_, _, _, err := h.readPromptScreenText(context.Background(), "a", at.Codex, "sid")
	require.NoError(t, err)
	assert.Equal(t, []int{80}, lt.asked, "another agent's program can print rules of its own: no deeper read, no request read from it")
}

func TestARequestOnAPTYScreenWhoseTopScrolledOffIsReadWhole(t *testing.T) {
	lt := &linesTerminal{mockSessionTerminal: newMockTerminal(), pane: strings.Repeat("older output\n", 30) + claudeBashScreen(longCommand(95))}
	h := &SessionsHandler{terminal: &screenAndScrollbackTerminal{lt}}
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	assert.False(t, s.OnlyReject, "the PTY's screen shows 50 rows; the request's top scrolled off above them and is in its scrollback: %s", s.Note)
	assert.Contains(t, s.Target, "line001")
	assert.Equal(t, []int{deepPromptCaptureLines}, lt.asked, "the screen read is the first; CaptureOutput is asked once, deep")
}

// divergingTerminal: the first read is the live screen (the last rows of live), the deeper read is a replay (deep) that may not be the same screen: a clipped ring, an older frame (Security's MUST on the PTY, #14575).
type divergingTerminal struct {
	*linesTerminal
	live, deep string
}

func (d *divergingTerminal) CaptureOutput(_ context.Context, _ string, lines int, _, _ string) (string, error) {
	d.asked = append(d.asked, lines)
	src := d.live
	if lines > promptCaptureLines {
		src = d.deep
	}
	all := strings.Split(src, "\n")
	if lines < len(all) {
		all = all[len(all)-lines:]
	}
	return strings.Join(all, "\n"), nil
}

func divergeRig(live, deep string) *SessionsHandler {
	return &SessionsHandler{terminal: &divergingTerminal{linesTerminal: &linesTerminal{mockSessionTerminal: newMockTerminal()}, live: live, deep: deep}}
}

// the first window of liveWith: the last 80 lines of a 95-line request, which misses its top
func TestADeeperReadThatIsNotTheSameScreenIsNotTaken(t *testing.T) {
	cmd := longCommand(95)
	live := strings.Repeat("older output\n", 30) + claudeBashScreen(cmd)
	read := func(h *SessionsHandler) promptScreen {
		s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
		require.NoError(t, err)
		require.True(t, ok)
		return s
	}
	// the matching deeper read is taken
	assert.False(t, read(divergeRig(live, live)).OnlyReject, "the same screen with more above it: read whole")
	// an older request's text left in the replay: the bottom (question and options) differs
	staleOpts := strings.Replace(live, "2. No", "2. No, and tell Claude what to do instead", 1)
	assert.True(t, read(divergeRig(live, staleOpts)).OnlyReject, "the replay's options differ from the live screen: the first read stands, Reject only")
	// an older frame of the SAME question and options but another command in the rows the first read shows
	staleCmd := strings.Replace(live, "line090", "rm -rf /", 1)
	s := read(divergeRig(live, staleCmd))
	assert.True(t, s.OnlyReject, "the replay shows another command in rows the live screen shows: Reject only")
	assert.NotContains(t, s.Target, "rm -rf", "and the card never shows the replay's text")
	// a different question
	otherQ := strings.Replace(live, "Do you want to proceed?", "Do you want to delete everything?", 1)
	assert.True(t, read(divergeRig(live, otherQ)).OnlyReject, "another question")
	// a ring clipped in the middle of the request: the deeper read does not reach the top either
	clipped := strings.Join(strings.Split(live, "\n")[len(strings.Split(live, "\n"))-90:], "\n")
	assert.True(t, read(divergeRig(live, clipped)).OnlyReject, "a clipped ring that still lacks the top: Reject only")
}

func TestRowsOfTheFirstReadAreTheEndOfTheDeeperOneAfterTrimming(t *testing.T) {
	assert.True(t, deepExtendsFirst("b  \nc\n\n", "a\nb\nc"), "trailing spaces and blank rows do not matter")
	assert.False(t, deepExtendsFirst("b\nc", "a\nb\nd"))
	assert.False(t, deepExtendsFirst("a\nb\nc", "b\nc"), "a deeper read shorter than the first cannot extend it")
	assert.False(t, deepExtendsFirst("", "a"), "nothing to compare")
}

func TestADeeperMissIsNotReadAgainAtEveryPollButIsAfterAFewSeconds(t *testing.T) {
	rule := strings.Repeat("╌", 110)
	pane := strings.Repeat(" more output\n", 200) + longCommand(10) + "\n" + rule + "\n This command requires approval\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"
	h, lt := deepRig(pane)
	now := time.Unix(1000, 0)
	deepMissNow = func() time.Time { return now }
	t.Cleanup(func() { deepMissNow = time.Now })
	read := func() {
		s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
		require.NoError(t, err)
		require.True(t, ok)
		assert.True(t, s.OnlyReject)
	}
	read()
	read()
	read()
	assert.Equal(t, []int{80, deepPromptCaptureLines, 80, 80}, lt.asked, "the miss is remembered: the second and third poll do not read 460 lines again")
	now = now.Add(deepMissTTL + time.Second)
	read()
	assert.Equal(t, []int{80, deepPromptCaptureLines, 80, 80, 80, deepPromptCaptureLines}, lt.asked, "after the few seconds it is read deep once more")
	lt.pane = strings.Replace(pane, "line001", "line777", 1) // another screen is another key: read deep at once
	read()
	assert.Equal(t, deepPromptCaptureLines, lt.asked[len(lt.asked)-1], "a changed screen is read deep at once")
}

func TestABindingFailureIsNotReadDeepAgainForAFewSeconds(t *testing.T) {
	live := strings.Repeat("older output\n", 30) + claudeBashScreen(longCommand(95))
	stale := strings.Replace(live, "2. No", "2. No, and tell Claude what to do instead", 1)
	lt := &divergingTerminal{linesTerminal: &linesTerminal{mockSessionTerminal: newMockTerminal()}, live: live, deep: stale}
	h := &SessionsHandler{terminal: lt}
	now := time.Unix(5000, 0)
	deepMissNow = func() time.Time { return now }
	t.Cleanup(func() { deepMissNow = time.Now })
	for i := 0; i < 3; i++ {
		s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
		require.NoError(t, err)
		require.True(t, ok)
		assert.True(t, s.OnlyReject)
	}
	assert.Equal(t, []int{80, deepPromptCaptureLines, 80, 80}, lt.asked, "a deeper read that was not the same screen is not read again at every poll")
	now = now.Add(deepMissTTL + time.Second)
	_, _, _, _ = h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	assert.Equal(t, deepPromptCaptureLines, lt.asked[len(lt.asked)-1], "after the few seconds it is tried again")
}
