package routes

import (
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// minStoredTail is how much of a request the screen must show (non-blank characters, the dialog's side bar aside) before it is tied to the call the hook reported: one short line proves nothing about which call the
// dialog is for.
const minStoredTail = 24

// screenWithStoredRequest is the screen as the dialog would have drawn it with its top, when the top is on no read (#15492: the Operator's phone showed only No for a 40-line `rm -rf $(cat ...)`): Claude reports a
// Bash call's command to PreToolUse before it asks, and the pending call holds it whole (the same text the chat shows, hidden characters written out, and an over-long or hiding request marked only_reject, which is
// refused here). It is used ONLY when what the screen shows above the closing dashed rule, up to its first row, is the END of that command (whitespace and the dialog's side bar aside, so a wrapped line matches): that
// ties the dialog on the screen to that call, and the part the screen never showed is the call's own text, which the agent cannot have drawn differently. Anything else (no pending Bash call, another tool, a tail that
// differs, a short one) gives nothing, and the request stays Reject only. The caller parses the result with the same parser and the same checks as any screen.
func (h *SessionsHandler) screenWithStoredRequest(sessionID, text string) (string, bool) {
	if sessionID == "" {
		return "", false
	}
	t, ok := h.pending.get(sessionID, time.Now())
	if !ok || t.ToolName != "Bash" {
		return "", false
	}
	if only, _ := t.Input["only_reject"].(bool); only {
		return "", false
	}
	cmd, _ := t.Input["command"].(string)
	if strings.TrimSpace(cmd) == "" {
		return "", false
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	closing := -1
	for i := len(lines) - 1; i >= 0 && i >= len(lines)-40; i-- {
		if dashedRuleRe.MatchString(lines[i]) {
			closing = i
			break
		}
	}
	if closing <= 0 {
		return "", false
	}
	tail := requestSkeleton(strings.Join(lines[:closing], "\n"))
	if utf8.RuneCountInString(tail) < minStoredTail || !strings.HasSuffix(requestSkeleton(cmd), tail) {
		return "", false
	}
	var b strings.Builder
	b.WriteString(strings.Repeat("─", 110) + "\n Bash command\n" + strings.Repeat("╌", 110) + "\n")
	for _, l := range strings.Split(cmd, "\n") {
		b.WriteString(" " + l + "\n")
	}
	b.WriteString(strings.Join(lines[closing:], "\n") + "\n")
	return b.String(), true
}

// requestSkeleton is a request's text without whitespace and without the dialog's side bar: what stays the same when a terminal wraps a line, indents it or draws a bar beside it.
func requestSkeleton(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || r == '│' || r == '|' {
			return -1
		}
		return r
	}, s)
}
