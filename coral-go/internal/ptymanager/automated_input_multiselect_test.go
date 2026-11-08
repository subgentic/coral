package ptymanager

import (
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14717 (the Operator's screenshot): Coral typed its board nudge into a Claude multi-select question; the text landed in the free-text row and was ticked as an answer. The question is taller than the
// 14 lines PromptOnScreen reads (rows 1 to 4 with their descriptions, the Next button, the rule, "Chat about this", the footer), so the row with the cursor (❯, row 1) scrolled out of the window, no visible row
// was selected, the footer alone was read as "not a menu", and the text went. A numbered list whose rows have check boxes is a question whatever the window holds, and so is a numbered list under a menu footer.

func multiSelectScreen(cursorRow int, footer bool) string {
	row := func(n int, label, desc string) string {
		mark := "  "
		if n == cursorRow {
			mark = "❯ "
		}
		return mark + string(rune('0'+n)) + ". [ ] " + label + "\n      " + desc + "\n"
	}
	var b strings.Builder
	b.WriteString("  For the short account menu (Settings, Account, Docs, Sign out), which items should it contain?\n\n")
	b.WriteString(row(1, "Settings", "Coral's settings (Themes moves inside Settings)."))
	b.WriteString(row(2, "Account", "The Hub Account page; Billing, Team, Team links, Usage and Goals become links there, so they stay one tap away."))
	b.WriteString(row(3, "Docs", "The documentation link."))
	b.WriteString(row(4, "Computers", "Keep it in the menu too (it also has its own tab)."))
	if cursorRow == 5 {
		b.WriteString("❯ 5. [ ] Type something.\n")
	} else {
		b.WriteString("  5. [ ] Type something.\n")
	}
	b.WriteString("     Next\n")
	b.WriteString("────────────────────────────────────────────────────────────\n")
	b.WriteString("  6. Chat about this\n")
	if footer {
		b.WriteString("\n  Enter to select · ↑/↓ to navigate · Esc to cancel\n")
	}
	return b.String()
}

func TestAMultiSelectQuestionTallerThanTheWindowIsAQuestion(t *testing.T) {
	for name, screen := range map[string]string{
		"the cursor on row 1, with its footer":    multiSelectScreen(1, true),
		"the cursor on row 1, no footer drawn":    multiSelectScreen(1, false),
		"the cursor on row 3, with its footer":    multiSelectScreen(3, true),
		"the cursor on the free-text row":         multiSelectScreen(5, true),
		"no cursor mark at all, with its footer":  multiSelectScreen(0, true),
		"no cursor mark at all, no footer either": multiSelectScreen(0, false),
	} {
		open, why := PromptOnScreen(screen)
		assert.True(t, open, name)
		assert.False(t, strings.HasPrefix(why, footerWhy) || strings.HasPrefix(why, busyWhy), "%s: read as a footer or busy, not a question: %q", name, why)

		a := &fakeAgent{screen: screen}
		n := "claude-t-multiselect"
		assert.Equal(t, Skipped, deliver(t, a, n, "You have 1 unread message on the message board. Run 'coral-board read' to see them."), name)
		assert.Empty(t, a.sent(), name)
		assert.Zero(t, a.enters, "%s: no Enter either", name)
		s, ok := SkippedOf(n)
		require.True(t, ok, name)
		assert.True(t, strings.HasPrefix(s.Why, SkipPrompt), "%s: %s", name, s.Why)
		ForgetSession(n)
	}
}

// A screen that cannot be read types nothing (the look fails closed), for a multi-select as for anything else.
func TestAMultiSelectOnAScreenThatCannotBeReadGetsNothing(t *testing.T) {
	a := &fakeAgent{screen: "", readErr: assert.AnError}
	n := "claude-t-multiselect-unreadable"
	assert.Equal(t, Skipped, deliver(t, a, n, "You have 1 unread message"))
	assert.Empty(t, a.sent())
	assert.Zero(t, a.enters)
	ForgetSession(n)
}

// The same words anywhere else are not a question: an agent's own numbered list with check boxes in a reply above an idle input box does not hold the text.
func TestACheckListInAReplyAboveAnIdleBoxIsNotAQuestion(t *testing.T) {
	a := &fakeAgent{screen: "● Here is the plan:\n\n  1. [ ] Write the test\n  2. [ ] Fix the bug\n  3. [ ] Run the suite\n\n" + idleInputBox}
	n := "claude-t-checklist-reply"
	assert.Equal(t, Sent, deliver(t, a, n, "You have 1 unread message"))
	ForgetSession(n)
}

// A plain (single-select) list longer than the window, its marked row scrolled above it, under the menu's own footer: still a menu, not "a footer alone" (the footer rule, apart from the check boxes).
func TestALongNumberedMenuWithItsMarkedRowAboveTheWindowIsAMenu(t *testing.T) {
	var b strings.Builder
	b.WriteString(" Select model\n\n ❯ 1. Default (recommended)\n")
	for i := 2; i <= 18; i++ {
		b.WriteString("   " + strconv.Itoa(i) + ". Model number " + strconv.Itoa(i) + "\n")
	}
	b.WriteString("\n Enter to select · ↑/↓ to navigate · Esc to exit\n")
	open, why := PromptOnScreen(b.String())
	assert.True(t, open)
	assert.False(t, strings.HasPrefix(why, footerWhy), "a footer alone: %q", why)
	a := &fakeAgent{screen: b.String()}
	n := "claude-t-longmenu"
	assert.Equal(t, Skipped, deliver(t, a, n, "You have 1 unread message"))
	assert.Empty(t, a.sent())
	ForgetSession(n)
}
