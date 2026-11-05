package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
)

// #13609: what the Operator types and sends is in the Activity record: a reply on a task, a typed answer to a question, any other message to the team. The same call by an agent's token is no click.
func wordRows(t *testing.T, bs *board.Store) []board.OperatorAction {
	t.Helper()
	rows, _, err := bs.ActivityPage(context.Background(), board.ActivityFilter{Limit: board.ActivityMaxLimit})
	require.NoError(t, err)
	return rows
}

func TestTheOperatorsReplyOnATaskIsARow(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Backend Dev", "Frontend Dev")
	id := e.task("p", "Backend Dev")
	path := "/api/board/p/tasks/" + itoa(id) + "/reply"
	code, _, b := e.do("POST", path, `{"content":"agent words"}`, map[string]string{"X-Test-Actor": "token:Frontend Dev"})
	require.Equal(t, 200, code, string(b))
	require.Empty(t, wordRows(t, e.bs), "an agent's reply is no click")
	code, _, b = e.do("POST", path, `{"content":"looks fine to me"}`, map[string]string{"X-Test-Actor": "operator-person"})
	require.Equal(t, 200, code, string(b))
	rows := wordRows(t, e.bs)
	require.Len(t, rows, 1)
	assert.Equal(t, board.ActTaskReply, rows[0].Action)
	assert.Equal(t, "task", rows[0].ItemKind)
	assert.Equal(t, itoa(id), rows[0].ItemID)
	assert.Equal(t, "p", rows[0].Team)
	assert.Equal(t, "A task", rows[0].Title)
	assert.Contains(t, rows[0].Note, "looks fine to me")
}

func TestTheOperatorsTypedAnswerToAQuestionIsARow(t *testing.T) {
	e := newReplyEnv(t)
	ctx := context.Background()
	e.join("p", "Lead", "Operator")
	q, err := e.bs.PostMessage(ctx, "p", "Lead", "@Operator which design do we ship?", nil)
	require.NoError(t, err)
	to, err := e.bs.AskTargets(ctx, "p", "Lead", q.Content)
	require.NoError(t, err)
	require.NoError(t, e.bs.RecordAsk(ctx, "p", q, to))
	body := `{"subscriber_id":"Operator","as":"Operator","content":"@Lead the second one","reply_to":` + itoa(q.ID) + `}`
	code, _, b := e.do("POST", "/api/board/p/messages", body, map[string]string{"X-Test-Actor": "operator-person"})
	require.Equal(t, 200, code, string(b))
	rows := wordRows(t, e.bs)
	require.Len(t, rows, 1)
	assert.Equal(t, board.ActAnswer, rows[0].Action)
	assert.Equal(t, "question", rows[0].ItemKind)
	assert.Equal(t, itoa(q.ID), rows[0].ItemID)
	assert.Contains(t, rows[0].Note, "the second one")
}

func TestAnyOtherMessageTheOperatorSendsIsARowAndAnAgentsIsNot(t *testing.T) {
	e := newReplyEnv(t)
	e.join("p", "Lead", "Operator")
	code, _, b := e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Lead","content":"status: done"}`, map[string]string{"X-Test-Actor": "token:Lead"})
	require.Equal(t, 200, code, string(b))
	require.Empty(t, wordRows(t, e.bs), "an agent's post is no click")
	code, _, b = e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Operator","as":"Operator","content":"@Lead please start on the parser"}`, map[string]string{"X-Test-Actor": "operator-person"})
	require.Equal(t, 200, code, string(b))
	rows := wordRows(t, e.bs)
	require.Len(t, rows, 1)
	assert.Equal(t, board.ActMessage, rows[0].Action)
	assert.Equal(t, "message", rows[0].ItemKind)
	assert.Contains(t, rows[0].Note, "start on the parser")
	// a dry run stores nothing, so it records nothing
	code, _, b = e.do("POST", "/api/board/p/messages", `{"subscriber_id":"Operator","as":"Operator","content":"@Lead hold on","dry_run":true}`, map[string]string{"X-Test-Actor": "operator-person"})
	require.Equal(t, 200, code, string(b))
	require.Len(t, wordRows(t, e.bs), 1)
}
