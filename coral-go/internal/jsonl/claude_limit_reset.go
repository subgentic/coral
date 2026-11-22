package jsonl

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// claudeResetRe reads the reset a Claude usage-limit notice names: "resets 5pm (America/New_York)", "resets 7:30pm (UTC)", "resets Nov 24, 5pm", "resets Nov 15 at 11pm (America/Los_Angeles)".
var claudeResetRe = regexp.MustCompile(`(?i)\bresets?\s+(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b(?:\s*\(([^)]{1,40})\))?`)

// ResetsAt is when the limit this error reports resets, and whether the text says. Older CLIs wrote "Claude AI usage limit reached|<unix seconds>"; newer ones name a clock time, in the zone they print (the
// local one when they print none), with a date only when it is not the next such time. A time with no date is the first one after the error was written. false: the text names no time that reads as one (the caller resumes nothing).
func (e ClaudeAPIError) ResetsAt() (time.Time, bool) {
	if !e.ResetAt.IsZero() {
		return e.ResetAt, true // read when the error was recorded, from the whole message
	}
	return e.parseReset()
}

// parseReset reads the reset from Text (ResetsAt's fallback, and what the capture uses on the uncapped text).
func (e ClaudeAPIError) parseReset() (time.Time, bool) {
	if !e.UsageLimit() {
		return time.Time{}, false
	}
	if _, after, ok := strings.Cut(e.Text, "|"); ok && strings.HasPrefix(e.Text, "Claude AI usage limit reached") {
		n, err := strconv.ParseInt(strings.TrimSpace(after), 10, 64)
		if err != nil || n < 1e9 || n > 1e11 {
			return time.Time{}, false
		}
		return time.Unix(n, 0), true
	}
	m := claudeResetRe.FindStringSubmatch(e.Text)
	if m == nil || e.At.IsZero() {
		return time.Time{}, false
	}
	loc := e.At.Location()
	if m[6] != "" {
		l, err := time.LoadLocation(strings.TrimSpace(m[6]))
		if err != nil {
			return time.Time{}, false // a zone it cannot place: not guessed
		}
		loc = l
	}
	hour, _ := strconv.Atoi(m[3])
	min := 0
	if m[4] != "" {
		min, _ = strconv.Atoi(m[4])
	}
	if hour < 1 || hour > 12 || min > 59 {
		return time.Time{}, false
	}
	hour %= 12
	if strings.EqualFold(m[5], "p") {
		hour += 12
	}
	from := e.At.In(loc)
	if m[1] != "" {
		month := monthOf(m[1])
		day, _ := strconv.Atoi(m[2])
		if month == 0 || day < 1 || day > 31 {
			return time.Time{}, false
		}
		at := time.Date(from.Year(), month, day, hour, min, 0, 0, loc)
		if at.Before(from) {
			at = at.AddDate(1, 0, 0)
		}
		return at, true
	}
	at := time.Date(from.Year(), from.Month(), from.Day(), hour, min, 0, 0, loc)
	if !at.After(from) {
		at = at.AddDate(0, 0, 1)
	}
	return at, true
}

func monthOf(s string) time.Month {
	s = strings.ToLower(s)
	if len(s) < 3 {
		return 0
	}
	for m := time.January; m <= time.December; m++ {
		if strings.HasPrefix(strings.ToLower(m.String()), s[:3]) {
			return m
		}
	}
	return 0
}
