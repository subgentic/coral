package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// The action list's thresholds default to coral-hub's numbers, a body that does not carry them means the defaults, and a value is kept in range (#11729).
func TestHealthActionListSettingsDefaultAndClamp(t *testing.T) {
	d := DefaultHealthSettings().ActionList
	assert.Equal(t, HealthActionList{StuckWaitMin: 10, OverloadedTasks: 5, OverloadedSleeping: 1, StaleReviewHours: 24, MentionMin: 30}, d)
	assert.Equal(t, d, HealthActionList{}.clamp(), "a body without the setting is the default, not the smallest value")
	got := HealthActionList{StuckWaitMin: 1, OverloadedTasks: 5000, OverloadedSleeping: -3, StaleReviewHours: 99999, MentionMin: 2}.clamp()
	assert.Equal(t, HealthActionList{StuckWaitMin: 5, OverloadedTasks: 100, OverloadedSleeping: 1, StaleReviewHours: 720, MentionMin: 5}, got)
	assert.Equal(t, 7, HealthActionList{StuckWaitMin: 7}.clamp().StuckWaitMin)
	assert.Equal(t, d, DefaultHealthSettings().Clamp().ActionList)
}
