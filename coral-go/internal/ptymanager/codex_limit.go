package ptymanager

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Codex's usage-limit notice, from its screen (#9267). It says so only in its own text, and an agent that hit the limit after a nudge started
// a turn that never ends by a hook, so the health check showed it "working". Two wordings of the reset exist:
//
//	■ You've hit your usage limit. Upgrade to Pro (https://...) or try again at Nov 1st, 2026 10:07 PM.
//	■ You've hit your usage limit. Try again in 3 days 2 hours 5 minutes.
//
// The idle screen's "You have 1 usage limit reset available" is not one.

var codexLimitRe = regexp.MustCompile(`(?i)^[^\p{L}\p{N}]*you['’]ve hit your usage limit\b`)

// codexLimitLines is how much of the screen's bottom counts: the notice scrolls away once Codex works again.
const codexLimitLines = 10

var (
	codexAbsResetRe = regexp.MustCompile(`(?i)\btry again at\s+(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?)?(\d{1,2}):(\d{2})\s*([ap])\.?m\b`)
	codexRelResetRe = regexp.MustCompile(`(?i)\btry again in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)`)
	codexRelPartRe  = regexp.MustCompile(`(?i)(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`)
)

// CodexLimitOnScreen reports whether Codex's screen shows its usage-limit notice near the bottom, and how long until it resets (0 when the
// screen does not say, or says something that is not a time). A reset time with no date is the next such time after now, in now's zone.
func CodexLimitOnScreen(screen string, now time.Time) (resets time.Duration, ok bool) {
	lines := tailLines(screenText(screen), codexLimitLines)
	for i := len(lines) - 1; i >= 0; i-- {
		if !codexLimitRe.MatchString(lines[i]) {
			continue
		}
		text := lines[i]
		for j := i + 1; j < len(lines) && j <= i+3; j++ { // the notice wraps at a narrow width
			if t := strings.TrimSpace(lines[j]); t != "" {
				text += " " + t
			}
		}
		return codexResetIn(text, now), true
	}
	return 0, false
}

func codexResetIn(text string, now time.Time) time.Duration {
	if m := codexRelResetRe.FindStringSubmatch(text); m != nil {
		var d time.Duration
		for _, p := range codexRelPartRe.FindAllStringSubmatch(m[1], -1) {
			n, _ := strconv.Atoi(p[1])
			switch strings.ToLower(p[2])[0] {
			case 'd':
				d += time.Duration(n) * 24 * time.Hour
			case 'h':
				d += time.Duration(n) * time.Hour
			case 'm':
				d += time.Duration(n) * time.Minute
			case 's':
				d += time.Duration(n) * time.Second
			}
		}
		return d
	}
	m := codexAbsResetRe.FindStringSubmatch(text)
	if m == nil {
		return 0
	}
	hour, _ := strconv.Atoi(m[4])
	min, _ := strconv.Atoi(m[5])
	if hour < 1 || hour > 12 || min > 59 {
		return 0
	}
	hour %= 12
	if strings.EqualFold(m[6], "p") {
		hour += 12
	}
	at := time.Date(now.Year(), now.Month(), now.Day(), hour, min, 0, 0, now.Location())
	if m[1] != "" { // a dated reset
		month := parseMonth(m[1])
		day, _ := strconv.Atoi(m[2])
		if month == 0 || day < 1 || day > 31 {
			return 0
		}
		year := now.Year()
		if m[3] != "" {
			year, _ = strconv.Atoi(m[3])
		}
		at = time.Date(year, month, day, hour, min, 0, 0, now.Location())
		if m[3] == "" && at.Before(now) {
			at = at.AddDate(1, 0, 0)
		}
	} else if at.Before(now) {
		at = at.AddDate(0, 0, 1)
	}
	if d := at.Sub(now); d > 0 {
		return d
	}
	return 0
}

func parseMonth(s string) time.Month {
	s = strings.ToLower(s)
	for m := time.January; m <= time.December; m++ {
		if strings.HasPrefix(strings.ToLower(m.String()), s[:min(len(s), 3)]) && len(s) >= 3 {
			return m
		}
	}
	return 0
}
