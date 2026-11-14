package routes

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #15996: the Hub's feed carries for_review_events, each {artifact, tagged} and nothing else; a dashboard's feed carries none; more than a frame holds is for_review_gap.
func reviewFeed(on bool) *coralFeed {
	return &coralFeed{prevSessions: map[string]string{}, prevByKey: map[string]map[string]any{}, prevRunsJSON: "[]", prevServersJSON: "null", firstMessage: false, reviewOn: on}
}

func reviewFrame(t *testing.T, f *coralFeed, evs []board.ForReviewEvent, gap bool) map[string]any {
	t.Helper()
	f.reviewEvents, f.reviewNow, f.reviewGap = evs, int64(len(evs)), gap
	tick := &wsTick{current: map[string]string{}, byKey: map[string]map[string]any{}, runsJSON: "[]", serversJSON: "null"}
	msg, kind := f.frame(tick, nil, nil, nil, time.Now(), time.Hour)
	if msg != nil {
		f.sent(kind, tick, nil, nil, time.Now())
	}
	return msg
}

func TestTheFeedCarriesTheForReviewEventsAndNothingElseOfThem(t *testing.T) {
	art := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	f := reviewFeed(true)
	m := reviewFrame(t, f, []board.ForReviewEvent{{Artifact: art, Tagged: true, Seq: 1}, {Artifact: art, Tagged: false, Seq: 2}}, false)
	require.NotNil(t, m, "an event alone makes a frame")
	b, err := json.Marshal(m["for_review_events"])
	require.NoError(t, err)
	assert.JSONEq(t, `[{"artifact":"`+art+`","tagged":true},{"artifact":"`+art+`","tagged":false}]`, string(b))
	assert.NotContains(t, m, "for_review_gap")
	assert.Equal(t, int64(2), f.reviewSeq, "told up to there")

	assert.Nil(t, reviewFrame(t, f, nil, false), "nothing new, no frame")
}

func TestTheFeedSaysForReviewGapWhenMoreThanAFrameHolds(t *testing.T) {
	var evs []board.ForReviewEvent
	for i := 1; i <= forReviewEventsPerFrame+1; i++ {
		evs = append(evs, board.ForReviewEvent{Artifact: "a", Tagged: true, Seq: int64(i)})
	}
	m := reviewFrame(t, reviewFeed(true), evs, false)
	require.NotNil(t, m)
	assert.Len(t, m["for_review_events"], forReviewEventsPerFrame)
	assert.Equal(t, true, m["for_review_gap"])

	m = reviewFrame(t, reviewFeed(true), nil, true)
	require.NotNil(t, m, "a gap alone makes a frame")
	assert.Equal(t, true, m["for_review_gap"])
	assert.NotContains(t, m, "for_review_events")
}
