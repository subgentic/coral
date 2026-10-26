package board

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// What an agent's dock lists of its board is what its read would deliver (#8484): ListMessagesFor and a peek take the same selection (selectRead), so for every member, role and
// receive mode, over a board long enough to need several batches, the list from the start is exactly the peek's set, and its pages are slices of it.
func TestTheDocksListIsWhatReadDelivers(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for name, spec := range map[string][2]string{"Worker": {"Backend", "all"}, "Quiet": {"Frontend", "mentions"}, "Muted": {"Reviewer", "none"}, "Lead": {"Orchestrator", "all"}, "Poster": {"Developer", "all"}} {
		_, err := s.Subscribe(ctx, "team", name, spec[0], "claude-"+name, nil, spec[1])
		require.NoError(t, err)
	}
	post := func(who, text string) {
		_, err := s.PostMessage(ctx, "team", who, text, nil)
		require.NoError(t, err)
	}
	post("Poster", "an update that tags nobody")
	for i := 0; i < 620; i++ { // more than one batch of selected messages for Worker
		post("Poster", fmt.Sprintf("@Worker item %d", i))
		if i%97 == 0 {
			post("Poster", "@all everyone read "+fmt.Sprint(i))
			post("Poster", "the Worker queue is long, no tag")
			post("Worker", "@Worker a note to myself")
			post("Poster", "@Quiet only you "+fmt.Sprint(i))
		}
	}
	_, err := s.PostSystemMessage(ctx, "team", "Coral Task Queue", "@Worker [Task #1] assigned to you", nil)
	require.NoError(t, err)

	ids := func(ms []Message) []int64 {
		out := make([]int64, len(ms))
		for i, m := range ms {
			out[i] = m.ID
		}
		return out
	}
	for _, who := range []string{"Worker", "Quiet", "Muted", "Lead", "Poster", "Nobody"} {
		t.Run(who, func(t *testing.T) {
			peek, err := s.PeekMessages(ctx, "team", who, 5000)
			require.NoError(t, err)
			want := ids(peek)

			all, page, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 5000})
			require.NoError(t, err)
			assert.Equal(t, want, ids(all), "the list from the start is exactly what a read would deliver")
			assert.Equal(t, len(want), page.Scanned, "and its total is that set")
			assert.Zero(t, page.Remaining)
			if who == "Worker" {
				assert.Greater(t, len(want), 500, "the board is long enough to take several batches")
			}

			// pages are slices of that set: the latest few, the few before the first of them, what comes after one
			if len(want) < 12 {
				return
			}
			latest, p, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 5})
			require.NoError(t, err)
			assert.Equal(t, want[len(want)-5:], ids(latest))
			assert.Equal(t, len(want)-5, p.Remaining, "how many are older than the page")
			before, p, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 5, BeforeID: latest[0].ID})
			require.NoError(t, err)
			assert.Equal(t, want[len(want)-10:len(want)-5], ids(before))
			assert.Equal(t, len(want)-10, p.Remaining)
			after, _, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 3, AfterID: want[len(want)-10], HasAfter: true})
			require.NoError(t, err)
			assert.Equal(t, want[len(want)-9:len(want)-6], ids(after))
			none, p, err := s.ListMessagesFor(ctx, "team", who, ForPage{Limit: 3, AfterID: want[len(want)-1], HasAfter: true})
			require.NoError(t, err)
			assert.Empty(t, none, "nothing after the newest")
			assert.Equal(t, len(want), p.Remaining, "an empty page after the newest has every selected message before it")
		})
	}

	// listing leaves the read position alone, and the real read still returns the same set
	before, err := s.ReadMessages(ctx, "team", "Quiet", 5000)
	require.NoError(t, err)
	listed, _, err := s.ListMessagesFor(ctx, "team", "Quiet", ForPage{Limit: 5000})
	require.NoError(t, err)
	assert.Equal(t, ids(before), ids(listed), "after a real read advanced the cursor, the list still shows the whole selection")
	again, err := s.ReadMessages(ctx, "team", "Quiet", 5000)
	require.NoError(t, err)
	assert.Empty(t, again, "the read position had moved only for the read")
}
