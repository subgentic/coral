package teamhealth

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func mins(ns ...int) []time.Duration {
	var out []time.Duration
	for _, n := range ns {
		out = append(out, time.Duration(n)*time.Minute)
	}
	return out
}

// Medians and percentiles, never averages: one very long task does not move them.
func TestMedianAndPercentileAreNotAverages(t *testing.T) {
	assert.Equal(t, 30*time.Minute, Median(mins(10, 30, 600)))
	assert.Equal(t, 20*time.Minute, Median(mins(10, 30)), "the mean of the two middle ones")
	assert.Equal(t, time.Duration(0), Median(nil))
	assert.Equal(t, 9*time.Minute, Percentile(mins(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), 90), "nearest rank: the 9th of 10")
	assert.Equal(t, 10*time.Minute, Percentile(mins(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), 100))
	assert.Equal(t, time.Minute, Percentile(mins(5, 1, 9), 1), "the smallest for a low percentile, whatever the order")
	assert.Equal(t, time.Duration(0), Percentile(nil, 90))
}

// Rule A (#11729): the agent's own history when it has five finished tasks, else the team's; the limit is the larger of twice the median and the 90th percentile.
func TestUsualTaskTimeUsesOwnHistoryThenTeamsThenNothing(t *testing.T) {
	own := mins(10, 12, 14, 16, 100) // median 14, p90 100
	u, ok := UsualTaskTime(own, mins(1, 1, 1, 1, 1, 1))
	assert.True(t, ok)
	assert.False(t, u.Team)
	assert.Equal(t, 14*time.Minute, u.Median)
	assert.Equal(t, 100*time.Minute, u.P90)
	assert.Equal(t, 100*time.Minute, u.TaskOverdue(), "p90 is above twice the median")
	u, ok = UsualTaskTime(mins(10, 10, 10, 10, 10), nil)
	assert.True(t, ok)
	assert.Equal(t, 20*time.Minute, u.TaskOverdue(), "twice the median is above p90")
	u, ok = UsualTaskTime(mins(10, 20), mins(30, 30, 30, 30, 30))
	assert.True(t, ok)
	assert.True(t, u.Team, "under five of its own: the team's numbers")
	assert.Equal(t, 60*time.Minute, u.TaskOverdue())
	_, ok = UsualTaskTime(mins(10, 20), mins(30, 30))
	assert.False(t, ok, "no history to speak of: nothing is flagged")
}

// Rule D: said when it crosses the threshold and again at each doubling; never while on time.
func TestLevelRisesOnlyAtEachDoubling(t *testing.T) {
	th := 30 * time.Minute
	for age, want := range map[time.Duration]int{0: 0, 29 * time.Minute: 0, 30 * time.Minute: 1, 59 * time.Minute: 1, 60 * time.Minute: 2, 119 * time.Minute: 2, 120 * time.Minute: 3, 8 * time.Hour: 5} {
		assert.Equal(t, want, Level(age, th), age.String())
	}
	assert.Equal(t, 0, Level(time.Hour, 0), "no threshold, no level")
}
