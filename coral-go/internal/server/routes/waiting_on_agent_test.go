package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// #19916: GET /api/waiting-on-agent lists what the Operator answered or commented that an agent has not acted on yet, for Inbox tab 2.

func readWaiting(t *testing.T, h *BoardHandler, person bool) (int, []map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/waiting-on-agent", nil)
	if person {
		req = asPerson(req)
	}
	w := httptest.NewRecorder()
	h.WaitingOnAgent(w, req)
	var body struct {
		Items []map[string]any `json:"items"`
	}
	if w.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	}
	return w.Code, body.Items
}

func TestWaitingOnAgentListsTheOperatorsAnswerUntilTheAskerPostsAgain(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "team", "Dev", "Backend Dev", "", nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "team", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "team", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	post := func(from, text string, replyTo int64) *board.Message {
		m, err := bs.PostMessage(ctx, "team", from, text, nil)
		require.NoError(t, err)
		if replyTo > 0 {
			require.NoError(t, bs.RecordReply(ctx, "team", m.ID, replyTo))
		}
		return m
	}
	ask := func(from, text string) *board.Message {
		q := post(from, text, 0)
		to, err := bs.AskTargets(ctx, "team", from, q.Content)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, to))
		return q
	}
	q1 := ask("Dev", "@Operator ship Friday or Thursday?\nmore detail on the second line")
	q2 := ask("Dev", "@Operator unanswered question")
	q3 := ask("Lead", "@Operator which parser?")
	q4 := ask("Lead", "@Dev not the Operator's") // another member's question
	_ = q2
	_ = q4
	long := strings.Repeat("word ", 100)
	post("Operator", long, q1.ID)
	post("Operator", "the second parser", q3.ID)
	post("Lead", "thanks, on it", 0) // Lead acted after the Operator's answer

	code, items := readWaiting(t, h, true)
	require.Equal(t, http.StatusOK, code)
	require.Len(t, items, 1, "the unanswered question, the one the asker acted on and the one asked of another member are not waiting")
	it := items[0]
	assert.Equal(t, "answered_ask", it["kind"])
	assert.Equal(t, "ask-"+itoa(q1.ID), it["id"])
	assert.Equal(t, "team", it["board"])
	assert.Equal(t, map[string]any{"name": "Dev", "role": "Backend Dev", "session_id": ""}, it["agent"])
	assert.Equal(t, "@Operator ship Friday or Thursday?", it["title"], "the ask's first line")
	words := it["operator_words"].(string)
	assert.LessOrEqual(t, len([]rune(words)), waitingWordsMax, "the Operator's words are cut")
	assert.True(t, strings.HasSuffix(words, "…"))
	_, perr := time.Parse(time.RFC3339, it["since"].(string))
	assert.NoError(t, perr)
	assert.Nil(t, it["goal"])
	assert.Nil(t, it["task"])
	assert.Nil(t, it["artifact"])
	assert.Nil(t, it["thread_id"])

	post("Dev", "got it, thanks", 0) // the asker acts: the row leaves
	_, items = readWaiting(t, h, true)
	assert.Empty(t, items)
}

func TestWaitingOnAgentIsTheOperatorsAloneAndHasNoAnswersOfTheirsWhenClosed(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	for _, who := range []string{"Dev", "Operator"} {
		_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	q, err := bs.PostMessage(ctx, "team", "Dev", "@Operator ok?", nil)
	require.NoError(t, err)
	to, _ := bs.AskTargets(ctx, "team", "Dev", q.Content)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, to))
	a, err := bs.PostMessage(ctx, "team", "Operator", "yes", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordReply(ctx, "team", a.ID, q.ID))

	code, items := readWaiting(t, h, false)
	assert.Equal(t, http.StatusForbidden, code, "a request that is not the person's (an agent's or a script's) is refused")
	assert.Empty(t, items)

	_, items = readWaiting(t, h, true)
	require.Len(t, items, 1)
	require.NoError(t, bs.CloseAsk(ctx, "team", q.ID, "Operator", "answered in chat"))
	_, items = readWaiting(t, h, true)
	assert.Empty(t, items, "a question closed by hand is not waiting")
}

func TestWaitingOnAgentListsCommentsSentToAnAgentOldestFirstWithTheAnsweredAsks(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "team", "Dev", "Backend Dev", "claude-sess-live", nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "team", "Operator", "", "", nil, "all")
	require.NoError(t, err)
	now := time.Now().UTC()
	h.SetWaitingComments(func(context.Context) ([]store.WaitingComment, error) {
		return []store.WaitingComment{
			{CommentID: 7, RootID: 7, ArtifactID: strings.Repeat("a", 64), Board: "team", AgentSession: "sess-1", AgentName: "Dev", Body: strings.Repeat("x", 400), Since: now.Add(-2 * time.Hour)},
		}, nil
	})
	q, err := bs.PostMessage(ctx, "team", "Dev", "@Operator pick one", nil)
	require.NoError(t, err)
	to, _ := bs.AskTargets(ctx, "team", "Dev", q.Content)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, to))
	a, err := bs.PostMessage(ctx, "team", "Operator", "the first", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordReply(ctx, "team", a.ID, q.ID))

	code, items := readWaiting(t, h, true)
	require.Equal(t, http.StatusOK, code)
	require.Len(t, items, 2)
	assert.Equal(t, "comment_sent", items[0]["kind"], "the comment is older than the answer: oldest first")
	assert.Equal(t, "cmt-7", items[0]["id"])
	assert.Equal(t, "answered_ask", items[1]["kind"])
	agent := items[0]["agent"].(map[string]any)
	assert.Equal(t, "Dev", agent["name"])
	assert.Equal(t, "Backend Dev", agent["role"])
	assert.Equal(t, "sess-live", agent["session_id"], "the live session of the agent on the board")
	assert.LessOrEqual(t, len([]rune(items[0]["operator_words"].(string))), waitingWordsMax)
	assert.Equal(t, "A file", items[0]["title"], "a file the team has no row for is still named")
}
