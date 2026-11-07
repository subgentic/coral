package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
	s, ok := parsePromptScreen(browserScreen)
	require.True(t, ok, "the menu is read although it has no numbers and no footer")
	assert.True(t, isBrowserPromptMenu(s))
	require.Len(t, s.Options, 3)
	assert.Equal(t, []string{"Install extension", "Not now", "Don't ask again"}, []string{s.Options[0].Label, s.Options[1].Label, s.Options[2].Label})
	assert.True(t, s.Options[1].Selected, "the cursor is on Not now")
	assert.True(t, s.Unnumbered)
	assert.Contains(t, s.Question, "Claude wants to use your browser")

	lookAlike := func(name, screen string) {
		t.Helper()
		if s, ok := parsePromptScreen(screen); ok {
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
