package ptymanager

import (
	"regexp"
	"strings"
)

// Codex refuses a model its login cannot use (#13480): "■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." It says so only on its own screen, in the turn a
// nudge started, and the turn ends with no hook that tells Coral it did no work: an agent in that state looked idle (and its unread messages piled up) until a person looked at its pane.

// codexModelRefusedRe: the notice starts its line behind Codex's ■ bullet; a program's echo or a pasted line without it is not the notice. The sentence can wrap at a narrow width, so only its start is matched.
var codexModelRefusedRe = regexp.MustCompile(`(?i)^\s*\x{25A0}\s*the\s+'([^']{1,80})'\s+model\s+is\s+not\s+supported\b`)

// codexModelRefusedLines is how much of the screen's bottom counts: the notice scrolls away once Codex works again.
const codexModelRefusedLines = 12

// CodexModelRefusedOnScreen reports whether Codex's screen shows its "model is not supported" notice near the bottom, and the model it names.
func CodexModelRefusedOnScreen(screen string) (model string, ok bool) {
	lines := tailLines(screenText(screen), codexModelRefusedLines)
	for i := len(lines) - 1; i >= 0; i-- {
		if m := codexModelRefusedRe.FindStringSubmatch(lines[i]); m != nil {
			return strings.TrimSpace(m[1]), true
		}
	}
	return "", false
}
