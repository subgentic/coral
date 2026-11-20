package healthcheck

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestScheduleRules(t *testing.T) {
	assert.NoError(t, Schedule{Every: "30m"}.Validate())
	assert.NoError(t, Schedule{Daily: "09:30", TZ: "Europe/Berlin"}.Validate())
	assert.Error(t, Schedule{Every: "4m"}.Validate(), "at most every 5 minutes")
	assert.Error(t, Schedule{Every: "200h"}.Validate())
	assert.Error(t, Schedule{Every: "soon"}.Validate())
	assert.Error(t, Schedule{}.Validate(), "one of the two")
	assert.Error(t, Schedule{Every: "1h", Daily: "09:00"}.Validate(), "not both")
	assert.Error(t, Schedule{Daily: "25:00"}.Validate())
	assert.Error(t, Schedule{Daily: "09:00", TZ: "Nowhere/Land"}.Validate())
}

func TestScheduleNext(t *testing.T) {
	t0 := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	assert.Equal(t, t0.Add(30*time.Minute), Schedule{Every: "30m"}.Next(t0))
	assert.Equal(t, time.Date(2026, 11, 21, 9, 30, 0, 0, time.UTC), Schedule{Daily: "09:30"}.Next(t0), "today's time has passed: tomorrow")
	assert.Equal(t, time.Date(2026, 11, 20, 11, 0, 0, 0, time.UTC), Schedule{Daily: "12:00", TZ: "Europe/Berlin"}.Next(t0), "12:00 Berlin is 11:00 UTC in November")
}
