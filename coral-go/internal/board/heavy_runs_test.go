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
