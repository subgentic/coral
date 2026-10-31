package routes

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// coral-board post --task N tells the task's assignee and its creator, never the poster (#11431). Before this the post was stored with its task and nobody was told unless the text @mentioned them.
func (e *replyEnv) postOnTask(project, poster string, id int64, content string) {
	e.t.Helper()
	code, _, b := e.do("POST", "/api/board/"+project+"/messages", `{"subscriber_id":`+jsonText(poster)+`,"content":`+jsonText(content)+`,"task_id":`+itoa(id)+`}`, map[string]string{"X-Test-Actor": "token:" + poster})
	require.Equal(e.t, 200, code, string(b))
}

func jsonText(s string) string { b, _ := json.Marshal(s); return string(b) }

func (e *replyEnv) inbox(project, who string) []string {
	e.t.Helper()
	got, err := e.bs.ReadMessages(context.Background(), project, who, 20)
	require.NoError(e.t, err)
	var out []string
	for _, m := range got {
		out = append(out, m.Content)
	}
	return out
}

func TestPostOnATaskNotifiesTheAssigneeAndTheCreatorNotThePoster(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Creator", "Assignee", "Third")
	id := e.task("p", "Creator")
	_, err := e.bs.ClaimTask(context.Background(), "p", "Assignee", id)
	require.NoError(t, err)

	e.postOnTask("p", "Third", id, "here is what I found")
	assert.Equal(t, []string{"@Assignee: @Creator: here is what I found"}, e.messagesContent("p", "?task_id="+itoa(id)))
	assert.Equal(t, []string{"@Assignee: @Creator: here is what I found"}, e.inbox("p", "Assignee"), "the assignee is told")
	assert.Equal(t, []string{"@Assignee: @Creator: here is what I found"}, e.inbox("p", "Creator"), "the creator is told")
	assert.Empty(t, e.inbox("p", "Third"), "the poster is not")

	e.postOnTask("p", "Assignee", id, "done")
	assert.Contains(t, e.messagesContent("p", "?task_id="+itoa(id)), "@Creator: done", "the assignee posting tells only the creator")
	e.postOnTask("p", "Creator", id, "thanks")
	assert.Contains(t, e.messagesContent("p", "?task_id="+itoa(id)), "@Assignee: thanks", "the creator posting tells only the assignee")
}

func TestPostOnATaskTellsOneMemberOnceAndSkipsWhoCannotBeTold(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Solo", "Other")
	id := e.task("p", "Solo")
	_, err := e.bs.ClaimTask(context.Background(), "p", "Solo", id)
	require.NoError(t, err)
	e.postOnTask("p", "Other", id, "one member is both")
	assert.Equal(t, []string{"@Solo: one member is both"}, e.messagesContent("p", "?task_id="+itoa(id)), "creator and assignee are one name: told once")

	gone := e.task("p", "Left the team")
	e.postOnTask("p", "Other", gone, "nobody to tell")
	assert.Equal(t, []string{"nobody to tell"}, e.messagesContent("p", "?task_id="+itoa(gone)), "a creator who is not a member is not tagged; the post is stored as it was")

	e.postOnTask("p", "Solo", id, "my own post on my own task")
	assert.Equal(t, "my own post on my own task", e.messagesContent("p", "?task_id="+itoa(id))[1], "the only one it names is the poster: no mention")
}

func (e *replyEnv) messagesContent(project, query string) []string {
	var out []string
	for _, m := range e.messages(project, query) {
		out = append(out, m.Content)
	}
	return out
}

// The answer to a post says who its text reaches (#11441): coral-board warns when it is no one.
func TestAPostAnswersWithWhoItReaches(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Dev A", "Dev B", "Poster")
	post := func(content string) []any {
		code, out, b := e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Poster","content":`+jsonText(content)+`}`, map[string]string{"X-Test-Actor": "token:Poster"})
		require.Equal(t, 200, code, string(b))
		n, ok := out["notified"].([]any)
		require.True(t, ok, "the field is always there: %s", string(b))
		return n
	}
	assert.Equal(t, []any{"Dev A"}, post("@Dev A the result is ready"))
	assert.ElementsMatch(t, []any{"Dev A", "Dev B"}, post("@Dev A @Dev B both of you"))
	assert.Equal(t, []any{}, post("see the @param in the docs"), "an @word that names no member reaches no one")
	assert.Equal(t, []any{}, post("a note to myself @Poster"), "the poster is never one of them")
	assert.Equal(t, []any{"all"}, post("@all heads up"))
	assert.Equal(t, []any{"Operator"}, post("@Operator please decide"))
	assert.Equal(t, []any{}, post("no mention at all"))

	// the Operator's own post that says @Operator reaches no one by it (QA Engineer's SHOULD on #11441)
	code, out, b := e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Operator","content":"a note from me, @Operator"}`, map[string]string{"X-Test-Actor": "operator"})
	require.Equal(t, 200, code, string(b))
	assert.Equal(t, []any{}, out["notified"], "the Operator is not told of their own post")
}
