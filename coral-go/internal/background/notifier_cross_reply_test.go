package background

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #9054: the nudge about a message from another board says how to answer it, one line; the nudge about an ordinary message says nothing of the kind.
func TestNudgeForAMessageFromAnotherBoardSaysHowToAnswerIt(t *testing.T) {
	ctx := context.Background()
	bs := testBoardStore(t)
	rt := &mockRuntime{}
	n := NewBoardNotifier(bs, rt, time.Second)
	n.now = func() time.Time { return time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC) }
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", SessionID: "orch", DisplayName: "Orchestrator"}}, nil
	})
	_, err := bs.Subscribe(ctx, "target", "Orchestrator", "Orchestrator", "claude-orch", nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "src", "Orchestrator", "Orchestrator", "claude-src", nil, "all")
	require.NoError(t, err)
	inbound, _, err := bs.PostCrossTeamMessage(ctx, board.CrossTeamPost{
		Origin:   board.MessageOrigin{ServerID: "local", Board: "src", Sender: "Orchestrator", SenderRole: "Orchestrator", TargetServerID: "local", TargetBoard: "target"},
		Mentions: []string{"Orchestrator"}, Content: "can you expose the tokens API?"})
	require.NoError(t, err)

	require.NoError(t, n.RunOnce(ctx))
	require.Len(t, rt.sent, 1)
	text := rt.sent[0].text
	assert.Contains(t, text, "coral-board read")
	assert.Contains(t, text, "is from another board")
	// By reference (goal #7): the sender's board name is shown by coral-board read, never typed.
	assert.Contains(t, text, "Message #"+strconv.FormatInt(inbound.ID, 10)+" is from another board; 'coral-board read' shows how to answer it.")
	assert.NotContains(t, text, "Reply with:")
	assert.NotContains(t, text, "\n", "one line")

	// an ordinary message: the plain nudge
	rt2 := &mockRuntime{}
	n2 := NewBoardNotifier(bs, rt2, time.Second)
	n2.now = n.now
	n2.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", SessionID: "orch", DisplayName: "Orchestrator"}}, nil
	})
	_, err = bs.ReadMessages(ctx, "target", "Orchestrator", 100)
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "target", "Dev", "@Orchestrator an ordinary message", nil)
	require.NoError(t, err)
	require.NoError(t, n2.RunOnce(ctx))
	require.Len(t, rt2.sent, 1)
	assert.NotContains(t, rt2.sent[0].text, "Reply with")
}
