package teamhealth

import (
	"github.com/stretchr/testify/assert"
	"testing"
	"time"
)

func TestUsageLimitHealthGroupsNamesAndResetClocks(t *testing.T) {
	at := time.Date(2026, 11, 22, 22, 7, 0, 0, time.UTC)
	entries := []BlockedEntry{{Name: "Backend", Vendor: "codex", ResetAt: at}, {Name: "Security", Vendor: "codex", ResetAt: at}, {Name: "Docs", Vendor: "claude"}, {Name: "Model", Vendor: "codex", ModelRefused: true}}
	lines := usageLimitHealthLines(entries)
	assert.Equal(t, []string{"1 Claude agent is stopped by a usage limit, reset time unknown: Docs. Nothing to nudge until it resets.", "2 Codex agents are stopped by a usage limit until Nov 22 22:07 UTC: Backend, Security. Nothing to nudge until it resets."}, lines)
}
