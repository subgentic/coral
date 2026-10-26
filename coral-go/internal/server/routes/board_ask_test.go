package routes

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7794: POST .../messages with ask makes the post a question to the members it @mentions (refused, and nothing posted, with nobody to ask); reply_to makes a post an answer to one;
// the board's message list carries ask (who is asked, who has not answered) and reply_to.
func TestAskAndReplyToOnTheMessagesRoute(t *testing.T) {
	server, _ := setupBoardTestServer(t)
	base := server.URL + "/api/board/askboard"
	for _, who := range []string{"Lead", "Dev A", "Dev B"} {
		postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": who, "job_title": who}).Body.Close()
	}
	post := func(payload map[string]any) (int, map[string]any) {
		resp := postJSON(t, base+"/messages", payload)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	// nobody to ask: refused, nothing posted
	status, out := post(map[string]any{"subscriber_id": "Lead", "content": "who has time?", "ask": true})
	assert.Equal(t, http.StatusBadRequest, status)
	assert.Contains(t, out["error"], "needs someone to ask")
	status, _ = post(map[string]any{"subscriber_id": "Lead", "content": "@all who has time?", "ask": true})
	assert.Equal(t, http.StatusBadRequest, status, "@all asks no one in particular")
	assert.Zero(t, countMessages(t, base), "a refused ask is not posted")

	// an ask is a post that carries who it asks
	status, q := post(map[string]any{"subscriber_id": "Lead", "content": "@Dev A @Dev B which parser do we keep?", "ask": true})
	require.Equal(t, http.StatusOK, status)
	ask, _ := q["ask"].(map[string]any)
	require.NotNil(t, ask, "the answer says it is a question: %v", q)
	assert.ElementsMatch(t, []any{"Dev A", "Dev B"}, ask["open"].([]any))
	assert.Equal(t, false, ask["answered"])
	qid := q["id"].(float64)

	// a reply_to that is no message of the board is refused, nothing posted
	n := countMessages(t, base)
	status, _ = post(map[string]any{"subscriber_id": "Dev A", "content": "the old one", "reply_to": 999999})
	assert.Equal(t, http.StatusBadRequest, status)
	assert.Equal(t, n, countMessages(t, base))

	status, r := post(map[string]any{"subscriber_id": "Dev A", "content": "the old one", "reply_to": qid})
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, qid, r["reply_to"], "a reply names what it answers")

	// the list carries it: Dev B still owes an answer
	resp, err := http.Get(base + "/messages/all")
	require.NoError(t, err)
	defer resp.Body.Close()
	var list []map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&list))
	var found map[string]any
	for _, m := range list {
		if m["id"] == qid {
			found = m
		}
	}
	require.NotNil(t, found)
	assert.Equal(t, []any{"Dev B"}, found["ask"].(map[string]any)["open"])
}

func countMessages(t *testing.T, base string) int {
	t.Helper()
	resp, err := http.Get(base + "/messages/all")
	require.NoError(t, err)
	defer resp.Body.Close()
	var list []map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&list))
	return len(list)
}
