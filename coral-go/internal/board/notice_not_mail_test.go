package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A board notice about an agent (sleep, wake, claim, assign) is not every agent's unread mail (#19608): the agent it is about gets only its own direct line (the one that names it with an @), the actor and
// every other agent get nothing, whatever their receive mode; the board view still lists the notice. One case per notice kind: who reads it, who the Stop hook's count (the sidebar count) and the nudge counts include.
func TestANoticeAboutAnAgentIsUnreadMailOnlyForTheAgentItNames(t *testing.T) {
	ctx := context.Background()
	kinds := []struct{ name, sender, content string }{
		{"sleep", "Coral", "[Coral] Orchestrator put Dev to sleep"},
		{"sleep to make room", "Coral", "[Coral] Orchestrator put Dev to sleep to make room for QA"},
		{"wake", "Coral", "[Coral] Orchestrator woke Dev"},
		{"stop", "Coral", "[Coral] Orchestrator stopped Dev's turn"},
		{"restart", "Coral", "[Coral] Orchestrator restarted Dev"},
		{"claim", "Coral Task Queue", "[Task #7 claimed by Dev] Some work"},
		{"assign", "Coral Task Queue", "[Task #7 assigned to Dev by Orchestrator] Some work"},
	}
	for _, k := range kinds {
		t.Run(k.name, func(t *testing.T) {
			s := testStore(t)
			sub := func(id, title, mode string, peek bool) {
				_, err := s.Subscribe(ctx, "b", id, title, "sess-"+id, nil, mode, peek)
				require.NoError(t, err)
			}
			sub("Orchestrator", "Orchestrator", "all", true) // the actor: reads everything
			sub("Dev", "Developer", "all", false)            // the agent it is about, in a receive-all mode
			sub("Other", "Developer", "all", false)          // a bystander in a receive-all mode
			sub("Quiet", "Developer", "mentions", false)
			_, err := s.PostSystemMessage(ctx, "b", k.sender, k.content, nil)
			require.NoError(t, err)

			sessions := []string{"sess-Orchestrator", "sess-Dev", "sess-Other", "sess-Quiet"}
			counts, err := s.GetUnreadCountsForSessions(ctx, sessions)
			require.NoError(t, err)
			for _, who := range []string{"Orchestrator", "Dev", "Other", "Quiet"} {
				assert.Equal(t, 0, counts["sess-"+who], "%s: the Stop hook counts nothing for %s", k.name, who)
				n, err := s.CheckUnread(ctx, "b", who)
				require.NoError(t, err)
				assert.Equal(t, 0, n, "%s: CheckUnread for %s", k.name, who)
				latest, err := s.LatestUnreadMessageID(ctx, "b", who)
				require.NoError(t, err)
				assert.Zero(t, latest, "%s: no latest unread message for %s", k.name, who)
				peek, err := s.PeekMessages(ctx, "b", who, 50)
				require.NoError(t, err)
				assert.Empty(t, peek, "%s: a plain read returns nothing for %s", k.name, who)
			}
			// the board view still shows it
			all, err := s.PeekMessages(ctx, "b", "Orchestrator", 50, true)
			require.NoError(t, err)
			require.Len(t, all, 1, "%s: read --all and the board view still list it", k.name)
		})
	}
}

// The direct line to the agent a notice is about, and a notice that tags someone, stay mail for that one agent only.
func TestADirectNoticeStaysMailForTheAgentItNames(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for _, id := range []string{"Orchestrator", "Dev", "Other"} {
		_, err := s.Subscribe(ctx, "b", id, "Developer", "sess-"+id, nil, "all", id == "Orchestrator")
		require.NoError(t, err)
	}
	_, err := s.PostSystemMessage(ctx, "b", "Coral", "@Dev [Coral] Woken by the Orchestrator: read the board before resuming any earlier command.", nil)
	require.NoError(t, err)
	_, err = s.PostSystemMessage(ctx, "b", "Coral Task Queue", "@Dev [Task #7 reassigned to you] Some work", nil)
	require.NoError(t, err)
	counts, err := s.GetUnreadCountsForSessions(ctx, []string{"sess-Orchestrator", "sess-Dev", "sess-Other"})
	require.NoError(t, err)
	assert.Equal(t, 1, counts["sess-Dev"], "the Coral line counts, the task queue's is counted by its own rule")
	assert.Equal(t, 0, counts["sess-Other"])
	assert.Equal(t, 0, counts["sess-Orchestrator"])
	got, err := s.PeekMessages(ctx, "b", "Dev", 50)
	require.NoError(t, err)
	require.NotEmpty(t, got)
	assert.Contains(t, got[0].Content, "Woken by the Orchestrator")
	for _, who := range []string{"Other", "Orchestrator"} {
		other, err := s.PeekMessages(ctx, "b", who, 50)
		require.NoError(t, err)
		assert.Empty(t, other, "%s does not read another agent's direct line", who)
	}
}
