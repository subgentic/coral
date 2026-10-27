package ptymanager

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #9267: Codex's usage-limit notice on its screen, in both wordings of the reset time.
func TestCodexLimitOnScreen(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	const tail = "\n\n› Ask Codex to do anything\n\n  gpt-5.5 high · ~/work\n"
	for name, c := range map[string]struct {
		screen string
		resets time.Duration
	}{
		"absolute date": {"■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 1st, 2026 10:07 PM." + tail,
			time.Date(2026, 11, 1, 22, 7, 0, 0, time.UTC).Sub(now)},
		"absolute date, wrapped": {"■ You've hit your usage limit. Upgrade to Pro or try again at\nNov 1st, 2026 10:07 PM.\n" + tail, time.Date(2026, 11, 1, 22, 7, 0, 0, time.UTC).Sub(now)},
		"absolute, no year":      {"■ You've hit your usage limit. Try again at Nov 3rd, 9:30 AM." + tail, time.Date(2026, 11, 3, 9, 30, 0, 0, time.UTC).Sub(now)},
		"absolute, time only":    {"■ You've hit your usage limit. Try again at 3:15 PM." + tail, 3*time.Hour + 15*time.Minute},
		"time only, tomorrow":    {"■ You've hit your usage limit. Try again at 8:00 AM." + tail, 20 * time.Hour},
		"relative":               {"■ You've hit your usage limit. Upgrade to Pro, or try again in 3 days 2 hours 5 minutes." + tail, 3*24*time.Hour + 2*time.Hour + 5*time.Minute},
		"relative, short":        {"■ You've hit your usage limit. Try again in 4h 30m." + tail, 4*time.Hour + 30*time.Minute},
		"no time shown":          {"■ You've hit your usage limit. Upgrade to Pro." + tail, 0},
		"12 AM is midnight":      {"■ You've hit your usage limit. Try again at Oct 28th, 12:00 AM." + tail, 12 * time.Hour},
	} {
		resets, ok := CodexLimitOnScreen(c.screen, now)
		assert.True(t, ok, name)
		assert.Equal(t, c.resets, resets, name)
	}
	for name, screen := range map[string]string{
		"idle":                   "› Ask Codex to do anything\n  gpt-5.5 high\n",
		"reset available notice": "You have 1 usage limit reset available\n› \n",
		"scrolled away":          "■ You've hit your usage limit. Try again in 1h.\n" + string(make([]byte, 0)) + "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n",
		"mentioned mid-line":     "the text says you've hit your usage limit somewhere\n",
		"month not a month":      "",
	} {
		_, ok := CodexLimitOnScreen(screen, now)
		assert.False(t, ok, name)
	}
	resets, ok := CodexLimitOnScreen("■ You've hit your usage limit. Try again at Foo 1st, 2026 10:07 PM."+tail, now)
	assert.True(t, ok)
	assert.Zero(t, resets, "an unreadable date is a limit with no time")
}
