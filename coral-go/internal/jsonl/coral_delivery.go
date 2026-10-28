package jsonl

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
	for _, re := range coralDeliveryRes {
		if re.MatchString(text) {
			return true
		}
	}
	return false
}

var (
	coralDeliveryRes = []*regexp.Regexp{
		regexp.MustCompile(`(?i)^You have \d+ unread messages? on the message board`),
		regexp.MustCompile(`(?i)^You have tasks available`),
		regexp.MustCompile(`(?i)^You have a new task in Coral \(#\d+:`),
		regexp.MustCompile(`(?i)^\[Task #\d+[^\]]*\]`),
		regexp.MustCompile(`(?i)^\[New Task #\d+[^\]]*\]`),
		regexp.MustCompile(`(?i)^\[Wait resolved\]`),
		regexp.MustCompile(`(?i)^\[Coral\b[^\]]*\]`),
		regexp.MustCompile(`(?i)^Stop hook feedback:`),
	}
	pastedRe        = regexp.MustCompile(`(?s)^<pasted_content[^>]*>(.*)</pasted_content>$`)
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
