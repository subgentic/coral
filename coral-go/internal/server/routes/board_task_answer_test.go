package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An agent's answer on a task (#7703): an ordinary post with a task_id, listed with the person's replies by ?task_id=N, with no mention added and the task untouched.
func TestAnAgentsPostWithATaskIdIsListedWithTheRepliesAndMentionsNobody(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Backend Dev", "Frontend Dev")
	id := e.task("p", "Backend Dev")
	code, _, b := e.do("POST", "/api/board/p/tasks/"+itoa(id)+"/reply", `{"content":"how far along?"}`, map[string]string{"X-Test-Actor": "operator"})
	require.Equal(t, 200, code, string(b))

	code, out, b := e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Backend Dev","content":"Done by tonight.","task_id":`+itoa(id)+`}`, map[string]string{"X-Test-Actor": "token:Backend Dev"})
	require.Equal(t, 200, code, string(b))
	assert.EqualValues(t, id, out["task_id"], "the answer says which task it is on")

	msgs := e.messages("p", "?task_id="+itoa(id))
	require.Len(t, msgs, 2, "the reply and the answer, oldest first")
	assert.Equal(t, "Operator", msgs[0].SubscriberID)
	assert.Equal(t, "Backend Dev", msgs[1].SubscriberID)
	assert.Equal(t, "Done by tonight.", msgs[1].Content, "no mention is added to an answer")
	require.NotNil(t, msgs[1].TaskID)
	assert.Equal(t, id, *msgs[1].TaskID)
}

func TestAPostWithATaskIdOfAnotherBoardOrNoTaskIsRefusedAndWritesNothing(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Backend Dev")
	e.join("q", "Backend Dev")
	other := e.task("q", "Backend Dev")
	hdr := map[string]string{"X-Test-Actor": "token:Backend Dev"}
	code, _, _ := e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Backend Dev","content":"hi","task_id":`+itoa(other)+`}`, hdr)
	assert.Equal(t, 404, code, "a task of another board is a 404")
	code, _, _ = e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Backend Dev","content":"hi","task_id":99999}`, hdr)
	assert.Equal(t, 404, code, "so is a task that does not exist")
	code, _, _ = e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Backend Dev","content":"hi","task_id":0}`, hdr)
	assert.Equal(t, 400, code, "and a task id of zero is a bad request")
	assert.Empty(t, e.messages("p", ""), "nothing was posted to the board")
	assert.Empty(t, e.messages("q", ""), "nor to the other one")
}

func TestAPlainPostIsStillNotLinkedToAnyTask(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Backend Dev")
	id := e.task("p", "Backend Dev")
	code, out, b := e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Backend Dev","content":"plain"}`, map[string]string{"X-Test-Actor": "token:Backend Dev"})
	require.Equal(t, 200, code, string(b))
	assert.NotContains(t, out, "task_id")
	assert.Empty(t, e.messages("p", "?task_id="+itoa(id)))
}
