package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A member is told "N unread" only for what its next plain read returns (#7757, the operator: "prevent notifications when there is nothing to read"): the messages that tag it, @all among them, whatever
// its receive mode says it receives. An orchestrator's plain read returns every unread message, so it is counted every one. The count, the latest id the nudge compares and the plain read agree.
func TestTheUnreadCountIsWhatAPlainReadReturns(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for name, spec := range map[string][2]string{"Worker": {"Backend", "all"}, "Quiet": {"Frontend", "mentions"}, "Lead": {"Orchestrator", "all"}, "Poster": {"Developer", "all"}} {
		_, err := s.Subscribe(ctx, "team", name, spec[0], "claude-"+name, nil, spec[1])
		require.NoError(t, err)
	}
	post := func(text string) int64 {
		m, err := s.PostMessage(ctx, "team", "Poster", text, nil)
		require.NoError(t, err)
		return m.ID
	}
	unread := func(who string) int { n, err := s.CheckUnread(ctx, "team", who); require.NoError(t, err); return n }
	latest := func(who string) int64 {
		id, err := s.LatestUnreadMessageID(ctx, "team", who)
		require.NoError(t, err)
		return id
	}
	peeked := func(who string) []string {
		ms, err := s.PeekMessages(ctx, "team", who, 50)
		require.NoError(t, err)
		var out []string
		for _, m := range ms {
			out = append(out, m.Content)
		}
		return out
	}

	// only an untagged message: nobody but the orchestrator is nudged, and a plain read finds nothing for them
	untagged := post("an update that tags nobody")
	assert.Zero(t, unread("Worker"), "a member in mode all is not nudged for a message its read will not show")
	assert.Zero(t, unread("Quiet"))
	assert.Zero(t, latest("Worker"), "and has no latest message to nudge about")
	assert.Empty(t, peeked("Worker"))
	assert.Equal(t, 1, unread("Lead"), "an orchestrator's read returns every message")
	assert.Equal(t, untagged, latest("Lead"))
	assert.Equal(t, []string{"an update that tags nobody"}, peeked("Lead"))

	// tagged: counted and returned; @all: counted and returned for everyone
	post("@Worker please look")
	post("@all everyone please read this")
	assert.Equal(t, 2, unread("Worker"))
	assert.Equal(t, []string{"@Worker please look", "@all everyone please read this"}, peeked("Worker"))
	assert.Equal(t, 1, unread("Quiet"), "@all reaches a member in mode mentions")
	assert.Equal(t, []string{"@all everyone please read this"}, peeked("Quiet"))
	assert.Equal(t, 3, unread("Lead"))

	// the plain read returns exactly what was counted, and the count is then 0
	got, err := s.ReadMessages(ctx, "team", "Worker", 50)
	require.NoError(t, err)
	assert.Len(t, got, 2)
	assert.Zero(t, unread("Worker"))
}
