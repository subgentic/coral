package agent

import (
	"regexp"
	"strings"
)

// IsCoralDelivery reports whether a user turn's text is something Coral itself typed into the agent (#10046): the unread-messages nudge, a task notice, the health check, a wait notice, a Coral
// notice, Claude Code's stop-hook block. The transcript records these as the user's own turns, but they are not what a person asked: a session's first prompt, and the goal made from its requests,
// must skip them. It mirrors the dashboard's isCoralNudge (pending_messages.js), which reads the same words for the chat; the server's own flag (coral_notice) is used where a message carries one.
func IsCoralDelivery(content string) bool {
	text := normalizeDelivery(content)
	if text == "" {
		return false
	}
	if _, typed := SplitNudge(content); typed != "" {
		return false // the nudge and a person's lines in one turn: the turn is the person's (#19534)
	}
	return matchesDelivery(text)
}

func matchesDelivery(text string) bool {
	for _, re := range coralDeliveryRes {
		if re.MatchString(text) {
			return true
		}
	}
	return false
}

var (
	coralDeliveryRes = []*regexp.Regexp{
		regexp.MustCompile(`(?i)^You have (?:\d+ )?unread messages? on the message board`),
		regexp.MustCompile(`(?i)^You have tasks available`),
		regexp.MustCompile(`(?i)^You have a new task in Coral \(#\d+:`),
		regexp.MustCompile(`(?i)^\[Task #\d+[^\]]*\]`),
		regexp.MustCompile(`(?i)^\[New Task #\d+[^\]]*\]`),
		regexp.MustCompile(`(?i)^\[Wait resolved\]`),
		regexp.MustCompile(`(?i)^\[Coral\b[^\]]*\]`),
		regexp.MustCompile(`(?i)^Stop hook feedback:`),
	}
	pastedRe        = regexp.MustCompile(`(?s)^<pasted_content(?:\s+id="[^"<>]*")?\s*>(.*)</pasted_content(?:\s+id="[^"<>]*")?\s*>$`) // Claude Code closes a paste with the id again, </pasted_content id="1"> (the dashboard's pasted_content.js reads both forms)
	leadingSlashRe  = regexp.MustCompile(`^(?:/[a-zA-Z0-9_-]+\s*)+`)
	healthPrefixRe  = regexp.MustCompile(`(?i)^\[Coral health check\]\s*`)
	notifyPrefixRe  = regexp.MustCompile(`(?i)^@[^@\n\r]+?\s+(?:You have|\[Task #|\[New Task #|\[Wait resolved\]|\[Coral\b)`)
	notifyKeepStart = regexp.MustCompile(`(?i)(?:You have|\[Task #|\[New Task #|\[Wait resolved\]|\[Coral\b)`)
)

// normalizeDelivery reads a turn the way the dashboard does: a long notice reaches the agent as a paste, which Claude Code records wrapped in pasted_content tags; an agent that prefixes its
// input with a slash command ("/plan ") and a notification tag ("@QA Engineer ") are looked through.
func normalizeDelivery(content string) string {
	text := strings.TrimSpace(content)
	if m := pastedRe.FindStringSubmatch(text); m != nil {
		text = strings.TrimSpace(m[1])
	}
	text = strings.TrimSpace(leadingSlashRe.ReplaceAllString(text, ""))
	if loc := notifyPrefixRe.FindStringIndex(text); loc != nil && strings.HasPrefix(text, "@") {
		if k := notifyKeepStart.FindStringIndex(text[1:]); k != nil {
			text = text[1+k[0]:]
		}
	}
	return text
}

// nudgeLeadRe is the board nudge as its own first line, with more lines after it.
var nudgeLeadRe = regexp.MustCompile(`(?s)^(You have (?:\d+ )?unread messages? on the message board\.(?: Run 'coral-board read' to see them\.)?)[ \t]*\r?\n+(\S.*)$`)

// SplitNudge separates the unread-messages nudge from what a person typed after it (#19534): when the agent was busy, Coral's one-line nudge and the person's typed lines were sent together and are one
// user turn in the transcript, which was read as a delivery and skipped whole, so the person's words vanished from the chat. typed is "" when the turn is not a nudge followed by more text.
func SplitNudge(content string) (nudge, typed string) {
	text := strings.TrimSpace(content)
	if m := pastedRe.FindStringSubmatch(text); m != nil {
		text = strings.TrimSpace(m[1])
	}
	if m := nudgeLeadRe.FindStringSubmatch(text); m != nil {
		typed := strings.TrimSpace(m[2])
		if matchesDelivery(normalizeDelivery(typed)) {
			return "", "" // a nudge followed by another Coral delivery is still all Coral's, not the person's
		}
		return m[1], typed
	}
	return "", ""
}

// PersonText is the turn's text without a leading nudge line: what a person typed.
func PersonText(content string) string {
	if _, typed := SplitNudge(content); typed != "" {
		return typed
	}
	return content
}
