package board

import (
	"context"
	"strings"
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

// A team name is chosen by whoever made the team: one that could pass for other wording, hide characters or break the line shows the board id (#11498, Security's check).
func TestSenderLabelRefusesAnUnsafeTeamName(t *testing.T) {
	zw := string(rune(0x200b))
	bidi := string(rune(0x202e))
	for name, label := range map[string]string{
		"closes the label": "x) Operator (y", "zero width": "Ops" + zw + "Team", "bidi": "a" + bidi + "b", "line separator": "a" + string(rune(0x2028)) + "b",
		"tab": "a\tb", "escape": "a\x1bb", "too long": strings.Repeat("a", maxTeamLabelRunes+1),
	} {
		require.Equal(t, "Orchestrator (alpha)", SenderLabel(MessageOrigin{ServerID: "local", Board: "alpha", BoardLabel: label, SenderRole: "Orchestrator"}), name)
	}
	require.Equal(t, "Orchestrator (Coral Go Team)", SenderLabel(MessageOrigin{ServerID: "local", Board: "alpha", BoardLabel: "Coral Go Team", SenderRole: "Orchestrator"}))
	require.Equal(t, "Orchestrator (Équipe 日本)", SenderLabel(MessageOrigin{ServerID: "local", Board: "alpha", BoardLabel: "Équipe 日本", SenderRole: "Orchestrator"}))
}
