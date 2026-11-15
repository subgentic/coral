package board

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A wait with no target ends on what reaches the waiter under its receive mode, not on every post (#17503): a member in mentions
// mode was woken for posts meant for others and answered "Nothing addressed to me", a paid turn each time.
func TestAWaitWithNoTargetEndsOnlyOnWhatReachesTheWaiter(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	for _, m := range []struct{ id, role, mode string }{
		{"Backend Dev", "Backend Dev", "mentions"}, {"Lead Developer", "Lead Developer", "mentions"},
		{"Reader", "Reader", "all"}, {"Orchestrator", "Orchestrator", "mentions"},
	} {
		_, err = s.Subscribe(ctx, "proj", m.id, m.role, "sess-"+m.id, nil, m.mode)
		require.NoError(t, err)
	}
	waits := func(id string) bool {
		t.Helper()
		_, err := s.RegisterWait(ctx, "proj", id, "sess-"+id, "message", "", "", time.Hour)
		require.NoError(t, err)
		return true
	}
	ends := func(id, sender, content string) bool {
		t.Helper()
		waits(id)
		matched, err := s.ResolveMatchingMessageWaits(ctx, "proj", sender, content)
		require.NoError(t, err)
		for _, w := range matched {
			if w.SubscriberID == id {
				return true
			}
		}
		require.NoError(t, s.CancelActiveWait(ctx, "proj", id))
		return false
	}

	assert.False(t, ends("Backend Dev", "Lead Developer", "@Orchestrator status of #17503?"), "a post naming another member does not end a mentions-mode wait")
	assert.False(t, ends("Backend Dev", "Lead Developer", "an update with no name in it"), "nor does a post that names nobody")
	assert.True(t, ends("Backend Dev", "Lead Developer", "@Backend Dev one more item"), "a post naming it does")
	assert.True(t, ends("Backend Dev", "Orchestrator", "@notify-all release is out"), "so does a broadcast")
	assert.False(t, ends("Backend Dev", "Orchestrator", "@Lead Developer and @Orchestrator only"), "a post naming two others does not")

	assert.True(t, ends("Reader", "Lead Developer", "an update with no name in it"), "a member that receives all keeps any message")
	assert.False(t, ends("Reader", "Lead Developer", "@Backend Dev one more item"), "except one meant for someone else")
	assert.True(t, ends("Orchestrator", "Lead Developer", "an update with no name in it"), "an orchestrator keeps any message")
}
