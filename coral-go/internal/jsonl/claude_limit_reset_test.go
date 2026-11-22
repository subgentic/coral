package jsonl

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestAClaudeLimitErrorSaysWhenItResets(t *testing.T) {
	at := time.Date(2026, 11, 22, 20, 0, 0, 0, time.UTC)
	ny, _ := time.LoadLocation("America/New_York")
	for _, c := range []struct {
		name string
		e    ClaudeAPIError
		want time.Time
		ok   bool
	}{
		{"older CLIs: unix seconds", ClaudeAPIError{Text: "Claude AI usage limit reached|1795400000", At: at}, time.Unix(1795400000, 0), true},
		{"a clock time in the printed zone", ClaudeAPIError{Kind: "rate_limit", Text: "You've hit your limit · resets 5pm (America/New_York)", At: at}, time.Date(2026, 11, 22, 17, 0, 0, 0, ny), true}, // 20:00Z is 15:00 in New York
		{"a clock time already past today is tomorrow's", ClaudeAPIError{Kind: "rate_limit", Text: "limit · resets 2:30pm (America/New_York)", At: at}, time.Date(2026, 11, 23, 14, 30, 0, 0, ny), true},
		{"UTC with minutes", ClaudeAPIError{Kind: "rate_limit", Text: "resets 11:15pm (UTC)", At: at}, time.Date(2026, 11, 22, 23, 15, 0, 0, time.UTC), true},
		{"a dated reset", ClaudeAPIError{Kind: "rate_limit", Text: "resets Nov 24, 9am (UTC)", At: at}, time.Date(2026, 11, 24, 9, 0, 0, 0, time.UTC), true},
		{"a zone it cannot place is not guessed", ClaudeAPIError{Kind: "rate_limit", Text: "resets 5pm (Not/AZone)", At: at}, time.Time{}, false},
		{"no time at all", ClaudeAPIError{Kind: "rate_limit", Text: "Request rejected (429)", At: at}, time.Time{}, false},
		{"not a limit", ClaudeAPIError{Kind: "authentication_failed", Text: "resets 5pm (UTC)", At: at}, time.Time{}, false},
		{"an absurd unix time", ClaudeAPIError{Text: "Claude AI usage limit reached|12", At: at}, time.Time{}, false},
		{"13 o'clock", ClaudeAPIError{Kind: "rate_limit", Text: "resets 13pm (UTC)", At: at}, time.Time{}, false},
	} {
		got, ok := c.e.ResetsAt()
		assert.Equal(t, c.ok, ok, c.name)
		if c.ok {
			assert.True(t, got.Equal(c.want), "%s: got %s want %s", c.name, got, c.want)
		}
	}
}
