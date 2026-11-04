package ptymanager

import (
	"regexp"
	"strings"
	"sync"
	"time"
)

// Codex refuses a model its login cannot use (#13480): "■ The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." It says so only on its own screen, in the turn a
// nudge started, and the turn ends with no hook that tells Coral it did no work: an agent in that state looked idle (and its unread messages piled up) until a person looked at its pane.

// codexModelRefusedRe: the notice starts its line behind Codex's ■ bullet, and may follow "Error running remote compact task:" (a real screen, 2026-11-04); a program's echo or a pasted line without it is not the notice. The sentence can wrap at a narrow width, so only its start is matched.
var codexModelRefusedRe = regexp.MustCompile(`(?i)^\s*\x{25A0}\s*(?:error[^:\n]{0,60}:\s*)?the\s+'([^']{1,80})'\s+model\s+is\s+not\s+supported\b`)

// codexModelNameRe is the shape of a model's name that is safe to repeat in a line typed into a terminal and posted to a board: letters, digits and . _ : / + - only, starting with a letter or digit. The name
// comes from the pane, which anything that can print a line behind Codex's bullet can write (Security's SHOULD on #13480); anything else is a refusal with no name.
var codexModelNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$`)

// codexModelRefusedLines is how much of the screen's bottom counts: the notice scrolls away once Codex works again.
const codexModelRefusedLines = 12

// CodexModelRefusedOnScreen reports whether Codex's screen shows its "model is not supported" notice near the bottom, and the model it names: "" when the name is not shaped like a model's (it is still a refusal).
func CodexModelRefusedOnScreen(screen string) (model string, ok bool) {
	lines := tailLines(screenText(screen), codexModelRefusedLines)
	for i := len(lines) - 1; i >= 0; i-- {
		if m := codexModelRefusedRe.FindStringSubmatch(lines[i]); m != nil {
			if name := strings.TrimSpace(m[1]); codexModelNameRe.MatchString(name) {
				return name, true
			}
			return "", true
		}
	}
	return "", false
}

// refusedReads is what the health monitor's screen reads last found for each Codex session (#13486): the live list and the chat say it from here and never read a screen of their own. Entries are
// dropped when they are read stale and when a read finds no refusal.
var refusedReads sync.Map // session id -> refusedRead

type refusedRead struct {
	model string
	at    time.Time
}

// NoteCodexModelRefusal records what a screen read found for a session at `at`: a refusal (model "" when the name is not a safe one), or none (which forgets an earlier one).
func NoteCodexModelRefusal(sessionID, model string, refused bool, at time.Time) {
	if !refused {
		refusedReads.Delete(sessionID)
		return
	}
	refusedReads.Store(sessionID, refusedRead{model: model, at: at})
}

// CodexModelRefusalOf is the refusal the last screen read found for a session, when it was made within maxAge of now: a read that is older says nothing, so a mark disappears by itself once Codex works again
// and nobody is reading its screen.
func CodexModelRefusalOf(sessionID string, maxAge time.Duration, now time.Time) (model string, refused bool) {
	v, ok := refusedReads.Load(sessionID)
	if !ok {
		return "", false
	}
	r := v.(refusedRead)
	if now.Sub(r.at) > maxAge {
		refusedReads.Delete(sessionID)
		return "", false
	}
	return r.model, true
}
