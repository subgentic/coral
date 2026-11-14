package routes

import (
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #14151: Claude's browser menu has no numbers and no footer; it is read by structure, and nothing near it is.
// The screen below is a REAL capture: tmux capture-pane -p of Claude Code 2.1.319 asked to open a page with the claude-in-chrome skill (the Beta Tester, #14151). Spaces kept: a row is 4 spaces and its label,
// or 2 spaces, the cursor mark, a space and its label; the description follows after 2 or more spaces, a different number each row; there is NO footer, and a rule of "─" sits above the title.
const browserScreen = `──────────────────────────────────────────────────────────────────────────────
 Claude wants to use your browser

  This task could use your Chrome browser. The Claude in Chrome extension lets Claude navigate sites, click buttons, and fill forms in your existing session.

    Install extension  Opens the install page in Chrome
  ❯ Not now            Continue without browser tools
    Don't ask again    Revisit anytime with /chrome
`

func TestBrowserMenu_ReadByStructure(t *testing.T) {
	s, ok := parseAgentScreen(at.Claude, browserScreen)
	require.True(t, ok, "the menu is read although it has no numbers and no footer")
	assert.True(t, isBrowserPromptMenu(s))
	require.Len(t, s.Options, 3)
	assert.Equal(t, []string{"Install extension", "Not now", "Don't ask again"}, []string{s.Options[0].Label, s.Options[1].Label, s.Options[2].Label})
	assert.True(t, s.Options[1].Selected, "the cursor is on Not now")
	assert.True(t, s.Unnumbered)
	assert.Contains(t, s.Question, "Claude wants to use your browser")

	lookAlike := func(name, screen string) {
		t.Helper()
		if s, ok := parseAgentScreen(at.Claude, screen); ok {
			assert.False(t, isBrowserPromptMenu(s), name)
		}
	}
	lookAlike("a label changed", strings.Replace(browserScreen, "Not now", "Not ever", 1))
	lookAlike("a fourth row", browserScreen+"    Something else    Does a thing\n")
	lookAlike("rows in another order", strings.Replace(strings.Replace(browserScreen, "Install extension", "Don't ask again!", 1), "Don't ask again    Revisit", "Install extension    Revisit", 1))
	lookAlike("no cursor mark", strings.Replace(browserScreen, "❯", " ", 1))
	lookAlike("two cursor marks", strings.Replace(browserScreen, "    Don't ask again", "  ❯ Don't ask again", 1))
	lookAlike("another title", strings.Replace(browserScreen, "Claude wants to use your browser", "Claude wants to use your files", 1))
	lookAlike("the title twice (a spoofed copy above)", " Claude wants to use your browser\n\n"+browserScreen)
	lookAlike("text after the rows", browserScreen+"\n⏺ Working\n")
	lookAlike("the title far above the rows", strings.Replace(browserScreen, "\n    Install extension", strings.Repeat("\n more text", 14)+"\n    Install extension", 1))
}

// Security's MUST on #14151: only a Claude session is read as either menu. The same screen on another agent type (or none) is no prompt, so there is nothing to offer and nothing to answer.
func TestBrowserAndTrustMenus_OnlyForClaude(t *testing.T) {
	trust := claudeUnnumbered(t, "trust.txt")
	for _, agent := range []string{at.Codex, at.Agy, at.Gemini, at.Terminal, at.Pi, "", "unknown"} {
		_, ok := parseAgentScreen(agent, browserScreen)
		assert.False(t, ok, "browser menu on %q", agent)
		if s, ok := parseAgentScreen(agent, trust); ok {
			assert.False(t, isFolderTrustMenu(s) && s.TrustFolder != "", "folder-trust folder read on %q", agent)
			assert.Empty(t, s.TrustFolder, "folder-trust folder read on %q", agent)
		}
	}
	b, ok := parseAgentScreen(at.Claude, browserScreen)
	require.True(t, ok)
	assert.True(t, isBrowserPromptMenu(b))
	s, ok := parseAgentScreen(at.Claude, trust)
	require.True(t, ok)
	assert.True(t, isFolderTrustMenu(s))
	assert.NotEmpty(t, s.TrustFolder)
}

// #16609: the screen below is a REAL capture, tmux capture-pane -p of Claude Code 2.1.325 (Haiku, Auto) asked to open a page with the claude-in-chrome skill: the "Skill(claude-in-chrome)" tool line, a rule, the title,
// the description over two lines, then the three rows, the cursor on Not now, and about 20 blank lines of the pane below. The rows' descriptions are worded differently from the 2.1.319 capture above.
func TestBrowserMenu_ReadFromARealClaude2_1_325Capture(t *testing.T) {
	raw, err := os.ReadFile("testdata/browser_menu_2_1_325.txt")
	require.NoError(t, err)
	s, ok := parseAgentScreen(at.Claude, string(raw))
	require.True(t, ok, "the real 2.1.325 screen is read")
	assert.True(t, isBrowserPromptMenu(s), "and is the browser menu")
	require.Len(t, s.Options, 3)
	assert.Equal(t, "Not now", s.Options[1].Label)
	assert.True(t, s.Options[1].Selected)
}

// #16609 (walk 26 F9): Not now on the Inbox row did nothing. The row sends the ask's id with the answer and refuses to send without one ("That question changed"), and the browser menu came out of its parser with NO ask_id
// (every other menu gets one in parsePromptScreenFor), so the row's click was refused before any key went, on a real session (found by asking a real Claude 2.1.325 for the browser skill through an isolated server: the chat reply's
// prompt_options carried the menu and no ask_id). The two REAL captures are the same menu a second apart: Claude blinks the pending tool's bullet ("⏺ Skill(...)" then "  Skill(...)"), which must not make another ask.
func TestBrowserMenu_HasAnAskIDThatSurvivesTheToolBulletBlinking(t *testing.T) {
	read := func(file string) promptScreen {
		raw, err := os.ReadFile(file)
		require.NoError(t, err)
		s, ok := parseAgentScreen(at.Claude, string(raw))
		require.True(t, ok, file)
		require.True(t, isBrowserPromptMenu(s), file)
		return s
	}
	on, off := read("testdata/browser_menu_2_1_325.txt"), read("testdata/browser_menu_2_1_325_bullet_off.txt")
	assert.NotEmpty(t, on.AskID, "the menu carries an ask id, as every other menu does: the row refuses to answer without one")
	assert.Equal(t, on.AskID, off.AskID, "the same ask whether the bullet is drawn or not")
	assert.True(t, samePrompt(on, off))
}
