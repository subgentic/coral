package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// A message from another team on this Coral names the team (#11498), not its board id; the reply hint still addresses the id.
func TestCrossTeamSenderLabelNamesTheTeam(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b, err := s.CreateBoard(ctx, "Coral Go Team", "test")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, b.ID, "Orchestrator", "Orchestrator", "tmux-a", nil, "mentions")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "beta", "Orchestrator", "Orchestrator", "tmux-b", nil, "mentions")
	require.NoError(t, err)
	in, _, err := s.PostCrossTeamMessage(ctx, CrossTeamPost{
		Origin:  MessageOrigin{ServerID: "local", Board: b.ID, Sender: "Orchestrator", SenderRole: "Orchestrator", TargetServerID: "local", TargetBoard: "beta"},
		Content: "hi", Mentions: []string{"Orchestrator"},
	})
	require.NoError(t, err)
	require.Equal(t, "Orchestrator (Coral Go Team)", in.SubscriberID)
	require.Contains(t, CrossReplyLine(in.External, in.ID), "--board "+shellWord(b.ID))
}

func TestSenderLabelFallsBackToTheIDWithoutALabel(t *testing.T) {
	require.Equal(t, "Orchestrator (alpha)", SenderLabel(MessageOrigin{ServerID: "local", Board: "alpha", SenderRole: "Orchestrator"}))
	require.Equal(t, "Orchestrator (alpha)", SenderLabel(MessageOrigin{ServerID: "local", Board: "alpha", BoardLabel: "alpha", SenderRole: "Orchestrator"}))
	require.Equal(t, "Orchestrator (alpha)", SenderLabel(MessageOrigin{ServerID: "local", Board: "alpha", BoardLabel: "x\ny", SenderRole: "Orchestrator"}))
}
