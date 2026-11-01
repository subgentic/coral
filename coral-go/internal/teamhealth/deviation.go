package teamhealth

import (
	"math"
	"sort"
	"time"
)

// Deviations from a member's own history (#11729 slice 3, coral-hub's operator): a task in progress far longer than its owner's usual, silence on a task far longer than its usual gap between
// posts, a wait far longer than that pair's usual answer. Medians and percentiles, never averages (one long task would drag an average up and hide the next). Each is said once when it crosses
// its threshold and again only at the next doubling; none is ever said while it is on time.

// MinOwnSamples is how many finished tasks an agent needs for its own history to be used; with fewer, the team's is.
const MinOwnSamples = 5

// MinGapSamples is how many gaps (so one more event) a task's own posts need for its usual gap; MinWaitSamples how many resolved waits a pair needs.
const (
	MinGapSamples  = 2
	MinWaitSamples = 3
)

// Median is the middle of ds (the mean of the two middle ones for an even count); 0 for none.
func Median(ds []time.Duration) time.Duration {
	if len(ds) == 0 {
		return 0
	}
	s := append([]time.Duration(nil), ds...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	if n := len(s); n%2 == 0 {
		return (s[n/2-1] + s[n/2]) / 2
	}
	return s[len(s)/2]
}

// Percentile is the p-th percentile (0 to 100) of ds by the nearest-rank method; 0 for none.
func Percentile(ds []time.Duration, p float64) time.Duration {
	if len(ds) == 0 {
		return 0
	}
	s := append([]time.Duration(nil), ds...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	rank := int(math.Ceil(p / 100 * float64(len(s))))
	return s[min(max(rank, 1), len(s))-1]
}

// Usual is a history's summary: its median and 90th percentile, how many samples it has, and whether it is the team's (the agent's own had too few).
type Usual struct {
	Median, P90 time.Duration
	N           int
	Team        bool
}

// UsualTaskTime is how long this agent's tasks usually take, from its own claimed-to-completed times (its last ~30), or the team's when it has fewer than MinOwnSamples; false when neither has enough.
func UsualTaskTime(own, team []time.Duration) (Usual, bool) {
	switch {
	case len(own) >= MinOwnSamples:
		return Usual{Median: Median(own), P90: Percentile(own, 90), N: len(own)}, true
	case len(team) >= MinOwnSamples:
		return Usual{Median: Median(team), P90: Percentile(team, 90), N: len(team), Team: true}, true
	}
	return Usual{}, false
}

// TaskOverdue is how long a task may be in progress before it is past its usual: the larger of twice the median and the 90th percentile.
func (u Usual) TaskOverdue() time.Duration { return max(2*u.Median, u.P90) }

// Level is how many times a duration has crossed its threshold: 0 below it, 1 from it, 2 from twice it, 3 from four times it (each doubling is a new level). A flag is said when the level rises.
func Level(age, threshold time.Duration) int {
	if threshold <= 0 || age < threshold {
		return 0
	}
	l := 1
	for t := threshold * 2; age >= t && l < 30; t *= 2 {
		l++
	}
	return l
}
