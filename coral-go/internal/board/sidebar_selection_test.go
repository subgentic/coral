package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The sidebar's per-agent unread badge shows a number only if the agent's plain read returns that many messages (#7757, the operator; the Orchestrator's answers): a member in mode all or in a group
// mode is counted the messages that tag it, an orchestrator in mode all is counted every one. The badge, the nudge's count and the read agree.
func TestTheSidebarBadgeAndTheNudgeCountAgreeWithAPlainRead(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for name, spec := range map[string][2]string{"InAll": {"Backend", "all"}, "InGroup": {"Frontend", "devs"}, "InMentions": {"Developer", "mentions"}, "Lead": {"Orchestrator", "all"}, "Poster": {"Developer", "all"}} {
		_, err := s.Subscribe(ctx, "team", name, spec[0], "tmux-"+name, nil, spec[1])
		require.NoError(t, err)
	}
	_, err := s.Subscribe(ctx, "team", "Peeker", "Developer", "tmux-Peeker", nil, "all", true) // an orchestrator by its can_peek flag alone
	require.NoError(t, err)
	require.NoError(t, s.AddToGroup(ctx, "team", "devs", "Poster")) // the group's posts used to be counted for a member in this group mode
	badge := func(who string) int {
		c, err := s.GetUnreadCountsForSessions(ctx, []string{"tmux-" + who})
		require.NoError(t, err)
		return c["tmux-"+who]
	}
	check := func(who string) int { n, err := s.CheckUnread(ctx, "team", who); require.NoError(t, err); return n }
	peek := func(who string) int {
		ms, err := s.PeekMessages(ctx, "team", who, 50)
		require.NoError(t, err)
		return len(ms)
	}
	agree := func(who string, want int) {
		t.Helper()
		assert.Equal(t, want, badge(who), "%s: the sidebar badge", who)
		assert.Equal(t, want, check(who), "%s: the nudge's count", who)
		assert.Equal(t, want, peek(who), "%s: what a plain read returns", who)
	}

	_, err = s.PostMessage(ctx, "team", "Poster", "a group member's update that tags nobody", nil)
	require.NoError(t, err)
	agree("InAll", 0)
	agree("InGroup", 0)
	agree("InMentions", 0)
	agree("Lead", 1)
	agree("Peeker", 1)

	_, err = s.PostMessage(ctx, "team", "Poster", "@InAll @InGroup @InMentions tagged for all three", nil)
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "team", "Poster", "@all for everyone", nil)
	require.NoError(t, err)
	agree("InAll", 2)
	agree("InGroup", 2)
	agree("InMentions", 2)
	agree("Lead", 3)
	agree("Peeker", 3)
}
