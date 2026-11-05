package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

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

// #13609 slice 2: the Mark read and Mark unread buttons and the tag editor are rows, told apart by the page's X-Coral-Click header; opening a file marks it read with no header and is no click. The row is read back
// from GET /api/activity.
func TestTheReadButtonsAndTheTagEditorAreRowsAndAnOpenIsNot(t *testing.T) {
	e := newTagEnv(t)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) { next.ServeHTTP(w, asPerson(req)) })
	})
	r.Use(ActivityRecorder(e.h.bs))
	r.Put("/api/board/{project}/artifacts/{id}/tags", e.h.SetArtifactTags)
	r.Get("/api/activity", e.h.ListActivity)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	id := e.ids["report.md"]
	put := func(body, click string) {
		req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/board/tag-team/artifacts/"+id+"/tags", strings.NewReader(body))
		require.NoError(t, err)
		if click != "" {
			req.Header.Set("X-Coral-Click", click)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
	}
	put(`{"tags":["read"]}`, "") // opening the file
	require.Empty(t, activityList(t, srv.URL), "an open is not a click")
	put(`{}`, "read")
	put(`{"tags":["read"]}`, "read")
	put(`{"tags":["internal","final"]}`, "tags")
	rows := activityList(t, srv.URL) // newest first
	require.Len(t, rows, 3)
	assert.Equal(t, board.ActFileTags, rows[0]["action"])
	assert.Equal(t, "internal, final", rows[0]["note"])
	assert.Equal(t, board.ActMarkRead, rows[1]["action"])
	assert.Equal(t, board.ActMarkUnread, rows[2]["action"])
	assert.Equal(t, id, rows[2]["item_id"])
	assert.Equal(t, "file", rows[2]["item_kind"])
}
