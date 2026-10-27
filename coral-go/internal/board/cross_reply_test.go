package board

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9054: how to answer a message from another board, built by the server from the message's envelope.
func TestCrossReplyLine(t *testing.T) {
	env := func(o MessageOrigin) RawJSON { b, _ := json.Marshal(o); return b }
	cases := map[string]struct {
		external RawJSON
		id       int64
		want     string
	}{
		"another team on this Coral": {env(MessageOrigin{Direction: "inbound", ServerID: "local", Board: "design-team"}), 812,
			`Reply with: coral-board send --board design-team --reply-to 812 "..."`},
		"a board name with a space is one shell word": {env(MessageOrigin{Direction: "inbound", ServerID: "local", Board: "QA team"}), 7,
			`Reply with: coral-board send --board 'QA team' --reply-to 7 "..."`},
		"no server id is this Coral": {env(MessageOrigin{Direction: "inbound", Board: "design-team"}), 9,
			`Reply with: coral-board send --board design-team --reply-to 9 "..."`},
		"a team on another Coral, over Coral Hub": {env(MessageOrigin{Direction: "inbound", ServerID: "3f2a9c1d-8e7b-4a65-9b10-aabbccddeeff", Board: "platform"}), 55,
			`Reply with: coral-board send --address id-3f2a9c1d8e7b/platform --reply-to 55 "..."`},
		"a server id that is not hex is sent to targets": {env(MessageOrigin{Direction: "inbound", ServerID: "homelab", Board: "platform"}), 56,
			`Reply with: coral-board send --address <server>/<team> --reply-to 56 "..." (the sender's address is in  coral-board targets)`},
		"the sender's own copy has no line": {env(MessageOrigin{Direction: "outbound", ServerID: "local", Board: "design-team"}), 5, ""},
		"an ordinary message has no line":   {nil, 5, ""},
		"an envelope that is not JSON":      {RawJSON("not json"), 5, ""},
		"no board in the envelope":          {env(MessageOrigin{Direction: "inbound", ServerID: "local"}), 5, ""},
		"no message id":                     {env(MessageOrigin{Direction: "inbound", ServerID: "local", Board: "x"}), 0, ""},
	}
	for name, c := range cases {
		assert.Equal(t, c.want, CrossReplyLine(c.external, c.id), name)
	}
}

// The line is on the messages the store gives back: the received copy of a message from another team, and not the sender's own copy.
func TestReadMessagesCarryTheReplyLineOfAMessageFromAnotherBoard(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	sub(s, ctx, "target", "orch", "Orchestrator")
	sub(s, ctx, "src", "orch2", "Orchestrator")
	inbound, outbound, err := s.PostCrossTeamMessage(ctx, CrossTeamPost{
		Origin:   MessageOrigin{ServerID: "local", Board: "src", Sender: "Orchestrator", SenderRole: "Orchestrator", TargetServerID: "local", TargetBoard: "target"},
		Mentions: []string{"orch"}, Content: "please look at the tokens API"})
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "target", "orch", "an ordinary message", nil)
	require.NoError(t, err)

	got, err := s.ListMessages(ctx, "target", 10, 0, 0)
	require.NoError(t, err)
	by := map[int64]Message{}
	for _, m := range got {
		by[m.ID] = m
	}
	assert.Equal(t, `Reply with: coral-board send --board src --reply-to `+itoa64(inbound.ID)+` "..."`, by[inbound.ID].ReplyWith)
	for _, m := range got {
		if m.ID != inbound.ID {
			assert.Empty(t, m.ReplyWith, "an ordinary message has none")
		}
	}
	mine, err := s.ListMessages(ctx, "src", 10, 0, 0)
	require.NoError(t, err)
	for _, m := range mine {
		assert.Empty(t, m.ReplyWith, "the sender's own copy (%d) has none", outbound.ID)
	}
	one, err := s.GetMessageByID(ctx, "target", inbound.ID)
	require.NoError(t, err)
	assert.NotEmpty(t, one.ReplyWith)
	b, _ := json.Marshal(one)
	assert.Contains(t, string(b), `"reply_with":"Reply with: coral-board send --board src`)
}

func itoa64(n int64) string { b, _ := json.Marshal(n); return string(b) }
