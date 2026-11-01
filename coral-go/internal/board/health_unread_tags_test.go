package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A sleeper's unread tags are told apart (#11803): a question open to it and a reply to its own post are for it; a message that tags it among
// others is a broadcast and earns no wake.
func TestUnreadTagsSeparatesWhatIsForTheMemberFromBroadcasts(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	for _, n := range []string{"Dev", "Lead", "Other"} {
		_, err := s.Subscribe(ctx, "proj", n, "Role "+n, "sess-"+n, nil, "all")
		require.NoError(t, err)
	}
	post := func(who, text string) *Message {
		m, err := s.PostMessage(ctx, "proj", who, text, nil)
		require.NoError(t, err)
		return m
	}
	mine := post("Dev", "I will take the review") // its own post: never a tag, and what a reply can answer
	post("Lead", "@Dev @Other @Lead status for everyone")
	post("Lead", "@Dev @Other heads up, the build moved")
	ask := post("Lead", "@Dev which file is it?")
	require.NoError(t, s.RecordAsk(ctx, "proj", ask, []string{"Dev"}))
	reply := post("Other", "@Dev see the second case")
	require.NoError(t, s.RecordReply(ctx, "proj", reply.ID, mine.ID))
	answered := post("Lead", "@Dev and the old question?")
	require.NoError(t, s.RecordAsk(ctx, "proj", answered, []string{"Dev"}))
	require.NoError(t, s.CloseAsk(ctx, "proj", answered.ID, "Lead", "answered in chat"))

	got, err := s.UnreadTags(ctx, "proj", "Dev")
	require.NoError(t, err)
	assert.Equal(t, 5, got.Total, "every tag after its last read")
	assert.Equal(t, 2, got.Directed, "the open question and the reply to its post; a closed question is a broadcast now")
	assert.False(t, got.Since.IsZero())
	assert.False(t, got.DirectedSince.IsZero())
	assert.False(t, got.DirectedSince.Before(got.Since))

	none, err := s.UnreadTags(ctx, "proj", "Other")
	require.NoError(t, err)
	assert.Equal(t, 2, none.Total)
	assert.Equal(t, 0, none.Directed, "the broadcasts tag it; the question was to Dev")
	assert.True(t, none.DirectedSince.IsZero())
}
