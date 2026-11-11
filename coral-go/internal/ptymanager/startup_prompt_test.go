package ptymanager

import (
	"strings"
	"testing"
)

func TestCodexRateLimitNoticeIsFoundByItsWordsAndRows(t *testing.T) {
	notice := "  Approaching rate limits\n  Switch to gpt-6-luna for lower credit usage?\n\n› 1. Switch to gpt-6-luna    Fast and affordable model for easier tasks\n  2. Keep current model\n  3. Keep current model (never show again)    Hide future rate limit reminders about\n     this model.\n\n  Press enter to confirm or esc to go back\n"
	if !CodexRateLimitNoticeOnScreen(notice) {
		t.Fatal("the notice is not found")
	}
	for name, screen := range map[string]string{
		"no third row":  strings.Replace(notice, "  3. Keep current model (never show again)", "  3. Something else", 1),
		"another title": strings.Replace(notice, "Approaching rate limits", "Rate limit reached", 1),
		"a chat line":   "I read about approaching rate limits: 1. switch to gpt, 2. keep current model, 3. keep current model (never show again)",
	} {
		if CodexRateLimitNoticeOnScreen(screen) {
			t.Errorf("%s: found as the notice", name)
		}
	}
}
