package jsonl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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

// #20692: the reset is read from the whole message when the error is recorded, so the 300-character cap on its text cannot cut it off.
func TestAClaudeLimitResetSurvivesTheTextCap(t *testing.T) {
	long := strings.Repeat("x", 400)
	line := `{"type":"assistant","isApiErrorMessage":true,"error":"rate_limit","timestamp":"2026-11-22T20:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"` + long + ` resets 11:15pm (UTC)"}]}}`
	var e ClaudeAPIError
	updateClaudeAPIError(&e, []byte(line))
	assert.Equal(t, claudeAPIErrorTextMax, len(e.Text), "the text is capped")
	assert.NotContains(t, e.Text, "resets", "and the time is cut off it")
	at, ok := e.ResetsAt()
	require.True(t, ok)
	assert.True(t, at.Equal(time.Date(2026, 11, 22, 23, 15, 0, 0, time.UTC)), at.String())
	assert.True(t, e.UsageLimit())
}

// #20697 (b): two limit records Claude Code really wrote (scrubbed of ids, paths and names, moved to Europe/Berlin and ten days on; the text, kind, status and times are as written). The wording of a real weekly limit has "at" between
// the date and the hour, and the record carries the exact reset in apiErrorParams.rate_limit_info.resetsAt.
func TestRealClaudeLimitRecordsGiveTheirResetFromTheTextAndFromTheRecord(t *testing.T) {
	for _, c := range []struct {
		file, text string
		reset      time.Time
	}{
		{"claude_limit_5h.jsonl", "You've hit your 5-hour limit · resets 8:10pm (Europe/Berlin)", time.Unix(1794683400, 0)},
		{"claude_limit_weekly.jsonl", "You've hit your weekly limit · resets Nov 26 at 8am (Europe/Berlin)", time.Unix(1795676400, 0)},
	} {
		line, err := os.ReadFile(filepath.Join("testdata", c.file))
		require.NoError(t, err)
		var e ClaudeAPIError
		updateClaudeAPIError(&e, line)
		assert.Equal(t, c.text, e.Text, c.file)
		assert.True(t, e.UsageLimit(), c.file)

		got, ok := e.ResetsAt()
		require.True(t, ok, c.file)
		assert.True(t, got.Equal(c.reset), "%s: the record's own resetsAt: got %s want %s", c.file, got, c.reset)

		// The words alone (an older record with no resetsAt) give the same time.
		e.ResetAt = time.Time{}
		got, ok = e.ResetsAt()
		require.True(t, ok, c.file+" from the text")
		assert.True(t, got.Equal(c.reset), "%s: from the text: got %s want %s", c.file, got, c.reset)
	}
}
