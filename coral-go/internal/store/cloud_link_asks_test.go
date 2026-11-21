package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #20413: an added link answers no ask until the person allows a kind; the enrollment's own link is unchanged; a kind outside the vocabulary is refused and ignored; the list goes with the link.
func TestAnAddedLinkAnswersOnlyTheAsksTheListAllows(t *testing.T) {
	cs, enrolled, added := twoLinks(t)
	ctx := context.Background()
	ok := func(link, kind string) bool {
		t.Helper()
		got, err := cs.LinkAskAllowed(ctx, link, kind)
		require.NoError(t, err)
		return got
	}
	for _, k := range tunnel.AskKinds() {
		assert.False(t, ok(added, k), "empty by default: "+k)
		assert.True(t, ok(enrolled, k), "the enrollment's own link answers as it always has: "+k)
	}
	assert.True(t, ok(enrolled, tunnel.AskKindLocalOnly), "and so does it for a route an added link never passes")
	assert.False(t, ok(added, tunnel.AskKindLocalOnly))
	assert.False(t, ok("lnk-ffffffff", tunnel.AskKindAgentAsk), "an unknown link answers nothing")

	require.NoError(t, cs.SetLinkAsk(ctx, added, tunnel.AskKindAgentAsk, true))
	assert.True(t, ok(added, tunnel.AskKindAgentAsk))
	assert.False(t, ok(added, tunnel.AskKindAskButton), "one kind is not another")
	got, err := cs.LinkAsksAllowed(ctx, added)
	require.NoError(t, err)
	assert.Equal(t, []string{"agent_ask"}, got)

	// Not for the enrollment's link, not for a kind outside the vocabulary.
	assert.ErrorIs(t, cs.SetLinkAsk(ctx, enrolled, tunnel.AskKindAgentAsk, true), ErrAskListNotForLink)
	for _, k := range []string{"permission", "check_approval", "device_key", "proposal", "local_only", ""} {
		assert.ErrorIs(t, cs.SetLinkAsk(ctx, added, k, true), ErrAskKind, k)
	}
	assert.ErrorIs(t, cs.SetLinkAsk(ctx, "lnk-ffffffff", tunnel.AskKindAgentAsk, true), ErrNoCloudLink)

	// A hand-written row for another kind is never an allowance and never listed.
	_, err = cs.db.ExecContext(ctx, `INSERT INTO link_ask_allow (link_id, ask_kind, created_at) VALUES (?, 'permission', 'x'), (?, 'local_only', 'x')`, added, added)
	require.NoError(t, err)
	assert.False(t, ok(added, "permission"))
	assert.False(t, ok(added, tunnel.AskKindLocalOnly))
	got, _ = cs.LinkAsksAllowed(ctx, added)
	assert.Equal(t, []string{"agent_ask"}, got)

	// It is read every call: stopping takes effect at once, and the change is logged.
	require.NoError(t, cs.SetLinkAsk(ctx, added, tunnel.AskKindAgentAsk, false))
	assert.False(t, ok(added, tunnel.AskKindAgentAsk))
	ev, err := cs.ListLinkEvents(ctx, added, 10)
	require.NoError(t, err)
	require.Len(t, ev, 2)
	assert.Equal(t, "ask-stop", ev[0].Action)
	assert.Equal(t, "ask-allow", ev[1].Action)

	// The list goes with the link: remove it and a link made again for the same Hub starts with none.
	require.NoError(t, cs.SetLinkAsk(ctx, added, tunnel.AskKindAskButton, true))
	require.NoError(t, cs.BeginRemoveLink(ctx, added))
	require.NoError(t, cs.FinishRemoveLink(ctx, added, LinkEventRemoved))
	var n int
	require.NoError(t, cs.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM link_ask_allow WHERE link_id = ?`, added))
	assert.Zero(t, n)
	assert.False(t, ok(added, tunnel.AskKindAskButton))
}
