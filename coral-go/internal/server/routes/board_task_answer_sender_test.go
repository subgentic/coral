package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An answer on a task names no sender of its own (#7703): the sender is the one the request proves. A body that names another member, or the Operator, is stored under the token's
// own name; through Coral Hub the stamped hub user is the sender and a task of another board is a 404.
func TestAnAnswerOnATaskIsFromTheSenderTheRequestProves(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Backend Dev", "Frontend Dev")
	id := e.task("p", "Backend Dev")
	tok := map[string]string{"X-Test-Actor": "token:Backend Dev"}
	for _, claim := range []string{"Frontend Dev", "Operator"} {
		code, _, b := e.do("POST", "/api/board/p/messages", `{"subscriber_id":"`+claim+`","content":"claimed","task_id":`+itoa(id)+`}`, tok)
		require.Equal(t, 200, code, string(b))
	}
	msgs := e.messages("p", "?task_id="+itoa(id))
	require.Len(t, msgs, 2)
	for _, m := range msgs {
		assert.Equal(t, "Backend Dev", m.SubscriberID, "the token's own name, never the name in the body")
	}
}

func TestAnAnswerOnATaskThroughCoralHubIsFromTheStampedHubUser(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Backend Dev")
	e.join("q", "Backend Dev")
	id := e.task("p", "Backend Dev")
	other := e.task("q", "Backend Dev")
	hub := hubReplyHdr("hub-user-1234abcd")
	code, _, b := e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Backend Dev","as":"Operator","content":"from the hub","task_id":`+itoa(id)+`}`, hub)
	require.Equal(t, 200, code, string(b))
	msgs := e.messages("p", "?task_id="+itoa(id))
	require.Len(t, msgs, 1)
	assert.Equal(t, "hub-user-1234abcd", msgs[0].SubscriberID, "the stamped hub user, not a name in the body")
	code, _, _ = e.do("POST", "/api/board/p/messages", `{"content":"other board","task_id":`+itoa(other)+`}`, hub)
	assert.Equal(t, 404, code, "a task of another board is a 404 through Coral Hub too")
	assert.Len(t, e.messages("p", "?task_id="+itoa(id)), 1)
	assert.Empty(t, e.messages("q", ""), "nothing was written to the other board")
}
