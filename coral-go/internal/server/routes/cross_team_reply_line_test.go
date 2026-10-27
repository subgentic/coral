package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9054: a message from another board says how to answer it, in the message itself (what coral-board read --json and the dashboard show). Both kinds.

func (e *crossTeamEnv) messagesOf(board string) []map[string]any {
	e.t.Helper()
	resp, err := http.Get(e.url + "/api/board/" + board + "/messages/all")
	require.NoError(e.t, err)
	defer resp.Body.Close()
	var out []map[string]any
	require.NoError(e.t, json.NewDecoder(resp.Body).Decode(&out))
	return out
}

func lastWith(msgs []map[string]any, key string) map[string]any {
	for i := len(msgs) - 1; i >= 0; i-- {
		if _, ok := msgs[i][key]; ok {
			return msgs[i]
		}
	}
	return nil
}

// Another team on this Coral: the received message says "coral-board send --board <sender's board> --reply-to <its id>", and the answer is recorded as a reply to it.
func TestMessageFromAnotherTeamOnThisCoralSaysHowToAnswerIt(t *testing.T) {
	e := newCrossTeamEnv(t)
	e.enable("alpha", true)
	e.enable("beta", true)
	code, out := e.send("alpha", "Orchestrator", "", "can you expose the tokens API before Friday?")
	require.Equal(t, http.StatusOK, code, out)
	inbound := lastWith(e.messagesOf("beta"), "reply_with")
	require.NotNil(t, inbound, "the received copy carries the line")
	id := int64(inbound["id"].(float64))
	assert.Equal(t, fmt.Sprintf(`Reply with: coral-board send --board alpha --reply-to %d "..."`, id), inbound["reply_with"])
	assert.Nil(t, lastWith(e.messagesOf("alpha"), "reply_with"), "the sender's own copy has none")

	// the answer: from beta's Orchestrator to alpha, naming the message it answers (an id on beta's board)
	reply := func(to string, replyTo int64) (int, map[string]any) {
		return e.do("POST", "/api/board/"+to+"/external-messages", map[string]any{"from_board": "beta", "subscriber_id": "Orchestrator", "session_name": "tmux-betaOrchestrator", "content": "done, it ships Thursday", "reply_to": replyTo})
	}
	code, out = reply("alpha", id)
	require.Equal(t, http.StatusOK, code, out)
	mirror := lastWith(e.messagesOf("beta"), "reply_to")
	require.NotNil(t, mirror, "beta's copy of its answer says what it answers")
	assert.Equal(t, float64(id), mirror["reply_to"])
	// the line of the answer is on alpha's board, to reply to beta in turn
	back := lastWith(e.messagesOf("alpha"), "reply_with")
	require.NotNil(t, back)
	assert.Contains(t, back["reply_with"], "coral-board send --board beta --reply-to")

	// a reply_to that is not a message beta received from that board is refused, and nothing is sent
	before := len(e.messagesOf("alpha"))
	code, out = reply("alpha", 999999)
	assert.Equal(t, http.StatusBadRequest, code, out)
	var ordinary int64
	for _, m := range e.messagesOf("beta") {
		if _, isCross := m["external"]; !isCross {
			ordinary = int64(m["id"].(float64))
		}
	}
	if ordinary > 0 {
		code, out = reply("alpha", ordinary)
		assert.Equal(t, http.StatusBadRequest, code, "an ordinary message is not one alpha sent: %v", out)
	}
	assert.Len(t, e.messagesOf("alpha"), before)
}

// A team on another Coral, delivered over Coral Hub: "coral-board send --address <server>/<team> --reply-to <id>", with the address in the form targets lists when the hub has no name for the server.
func TestMessageFromAnotherCoralSaysHowToAnswerIt(t *testing.T) {
	e := newCrossTeamEnv(t)
	e.enable("beta", true)
	_, _ = e.allowServers(relaySrc)
	code, out := e.relay("auth", "", relayBody("m1", 0, "please run the pre-land check"))
	require.Equal(t, http.StatusOK, code, out)
	msg := lastWith(e.betaMessages(), "reply_with")
	require.NotNil(t, msg)
	id := int64(msg["id"].(float64))
	assert.Equal(t, fmt.Sprintf(`Reply with: coral-board send --address id-0b6c6a528a0e/epoch-tests --reply-to %d "..."`, id), msg["reply_with"])
}
