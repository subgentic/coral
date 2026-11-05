package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13671: the "before the queue" baseline comes from the board's own HEAVY RUN START / END posts: runs by poster and machine, the minutes two of them overlapped, and the slot-request posts.

func at(h, m int) time.Time { return time.Date(2026, 11, 4, h, m, 0, 0, time.UTC) }

func TestHeavyRunsPairAStartWithItsPostersNextEndAndReadTheMachine(t *testing.T) {
	runs := HeavyRuns([]HeavyPost{
		{Who: "QA", Text: "@Orchestrator HEAVY RUN START: QA, mini, heap_growth x10", At: at(9, 0)},
		{Who: "Dev", Text: "HEAVY RUN START: Dev, Mac, go test ./...", At: at(9, 10)},
		{Who: "QA", Text: "HEAVY RUN END: QA, mini, lock released", At: at(9, 40)},
		{Who: "Dev", Text: "@Orchestrator HEAVY RUN END (Mac)", At: at(10, 0)},
	}, at(23, 0))
	require.Len(t, runs, 2)
	assert.Equal(t, HeavyRun{Who: "QA", Machine: "mini", Start: at(9, 0), End: at(9, 40)}, runs[0])
	assert.Equal(t, "Mac", runs[1].Machine, "no machine named: the Mac")
	assert.Equal(t, 50*time.Minute, runs[1].End.Sub(runs[1].Start))
}

func TestAStartWithNoEndIsCutAndMarkedAndAQuotedRuleIsNotARun(t *testing.T) {
	runs := HeavyRuns([]HeavyPost{
		{Who: "Orchestrator", Text: "Before starting one, post 'HEAVY RUN START <what>' and wait", At: at(8, 0)},
		{Who: "Dev", Text: "HEAVY RUN START: Dev, Mac", At: at(9, 0)},
	}, at(23, 0))
	require.Len(t, runs, 1, "a rule that quotes the words is not a run")
	assert.True(t, runs[0].Unclosed)
	assert.Equal(t, UnclosedRunCap, runs[0].End.Sub(runs[0].Start), "an open run is cut, not counted to the end of the day")
}

func TestOverlapMinutesCountOnlyTimeWithTwoOrMoreRunsOnOneMachineByDay(t *testing.T) {
	runs := []HeavyRun{
		{Who: "A", Machine: "Mac", Start: at(9, 0), End: at(10, 0)},
		{Who: "B", Machine: "Mac", Start: at(9, 30), End: at(10, 30)}, // 30 minutes with A
		{Who: "C", Machine: "mini", Start: at(9, 0), End: at(11, 0)},  // another machine: not an overlap
	}
	o := OverlapMinutes(runs)
	assert.Equal(t, 30, o["2026-11-04"]["Mac"])
	assert.Equal(t, 0, o["2026-11-04"]["mini"])
}

func TestSlotRequestPostsAreCountedByDayFromANamedList(t *testing.T) {
	posts := []HeavyPost{
		{Who: "A", Text: "I am waiting for the Orchestrator to call me for the Mac", At: at(9, 0)},
		{Who: "B", Text: "Need the next isolated perf slot", At: at(11, 0)},
		{Who: "C", Text: "unrelated post", At: at(12, 0)},
	}
	n := SlotRequestPosts(posts)
	assert.Equal(t, 2, n["2026-11-04"])
	assert.NotEmpty(t, SlotRequestPhrases)
}

func TestWaitForAMachineIsFromASlotRequestToThePostersNextStartAndCutAtTwoHours(t *testing.T) {
	posts := []HeavyPost{
		{Who: "A", Text: "waiting for the Orchestrator", At: at(9, 0)},
		{Who: "B", Text: "need the next isolated perf slot", At: at(9, 0)},
	}
	runs := []HeavyRun{{Who: "A", Machine: "Mac", Start: at(9, 20), End: at(9, 50)}, {Who: "B", Machine: "Mac", Start: at(13, 0), End: at(13, 10)}}
	w := SlotWaits(posts, runs)
	require.Len(t, w, 1, "B's start is beyond two hours: no sample")
	assert.Equal(t, 20*time.Minute, w[0].Wait)
	assert.Equal(t, "2026-11-04", w[0].Day)
}

func TestHeavyPostsReadsThePostsOfAWindowAndNeverASystemPost(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	_, err := s.PostMessage(ctx, "team", "Dev", "HEAVY RUN START: Dev, Mac", nil)
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "team", "Dev", "just chatting about lunch", nil)
	require.NoError(t, err)
	got, err := s.HeavyPosts(ctx, "", time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Contains(t, got[0].Text, "HEAVY RUN START")
	assert.NotEmpty(t, got[0].Who)
}

func TestOverlapMinutesInAWindowClipsRunsAtItsEdges(t *testing.T) { // the cut falls inside a day: a run is split at it, never counted on both sides
	runs := []HeavyRun{
		{Who: "A", Machine: "Mac", Start: at(14, 0), End: at(18, 0)},
		{Who: "B", Machine: "Mac", Start: at(15, 0), End: at(17, 0)}, // overlap 15:00-17:00
	}
	cut := at(16, 0)
	before := OverlapMinutesIn(runs, at(0, 0), cut)
	since := OverlapMinutesIn(runs, cut, at(23, 0))
	assert.Equal(t, 60, before, "15:00 to 16:00 is before the cut")
	assert.Equal(t, 60, since, "16:00 to 17:00 is after it")
	assert.Equal(t, 120, OverlapMinutes(runs)["2026-11-04"]["Mac"], "the day's total is both halves, each counted once")
	assert.Equal(t, 0, OverlapMinutesIn(runs, at(19, 0), at(23, 0)), "a window with no run in it has no overlap")
}

func TestPostsInAWindowAreThoseWithinItsEdges(t *testing.T) {
	posts := []HeavyPost{{Who: "A", Text: "waiting for the Orchestrator", At: at(15, 59)}, {Who: "B", Text: "waiting for the Orchestrator", At: at(16, 0)}}
	assert.Equal(t, 1, len(PostsIn(posts, at(0, 0), at(16, 0))), "a post at the cut belongs to the since side")
	assert.Equal(t, 1, len(PostsIn(posts, at(16, 0), at(23, 0))))
}

func TestARunStillOpenIsCountedUpToTheWindowsEnd(t *testing.T) { // Lead's SHOULD: an open run is not dropped
	now := at(16, 30)
	runs := HeavyRuns([]HeavyPost{
		{Who: "A", Text: "HEAVY RUN START: A, Mac", At: at(15, 0)},
		{Who: "B", Text: "HEAVY RUN START: B, Mac", At: at(16, 0)},
	}, now)
	require.Len(t, runs, 2)
	assert.True(t, runs[0].Unclosed && runs[1].Unclosed)
	assert.Equal(t, now, runs[0].End, "an open run lasts to now, not to nothing")
	assert.Equal(t, 30, OverlapMinutesIn(runs, at(16, 0), now), "both were open from 16:00 to 16:30")
}
