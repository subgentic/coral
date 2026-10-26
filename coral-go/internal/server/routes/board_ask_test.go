package routes

import (
	"encoding/json"
	"net/http"
	"strconv"
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

// #8200: a page of messages after the newest one the dashboard holds also carries ask_updates: the older questions those posts may have answered,
// with who still owes an answer now, so the client never derives "answered" itself.
func TestAskUpdatesComeWithTheNextPage(t *testing.T) {
	server, _ := setupBoardTestServer(t)
	base := server.URL + "/api/board/askupdates"
	for _, who := range []string{"Lead", "Dev A", "Dev B", "Other"} {
		postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": who, "job_title": who}).Body.Close()
	}
	post := func(payload map[string]any) map[string]any {
		resp := postJSON(t, base+"/messages", payload)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	page := func(after float64) map[string]any {
		resp, err := http.Get(base + "/messages/all?format=dashboard&after_id=" + strconv.FormatInt(int64(after), 10))
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}
	updates := func(p map[string]any) map[float64]map[string]any {
		out := map[float64]map[string]any{}
		for _, u := range asSlice(p["ask_updates"]) {
			m := u.(map[string]any)
			out[m["id"].(float64)] = m["ask"].(map[string]any)
		}
		return out
	}

	q := post(map[string]any{"subscriber_id": "Lead", "content": "@Dev A @Dev B which parser do we keep?", "ask": true})
	qid := q["id"].(float64)
	held := post(map[string]any{"subscriber_id": "Lead", "content": "a note after it"})["id"].(float64) // the newest message the dashboard holds

	// a post by someone who was not asked changes nothing: no update, and no key
	post(map[string]any{"subscriber_id": "Other", "content": "no idea"})
	p := page(held)
	assert.NotContains(t, p, "ask_updates", "nobody asked posted: %v", p)

	// Dev A answers with reply_to: the question comes with Dev B still owing
	post(map[string]any{"subscriber_id": "Dev A", "content": "the old one", "reply_to": qid})
	u := updates(page(held))
	require.Contains(t, u, qid)
	assert.Equal(t, []any{"Dev B"}, u[qid]["open"])
	assert.Equal(t, false, u[qid]["answered"])
	assert.ElementsMatch(t, []any{"Dev A", "Dev B"}, u[qid]["to"])

	// Dev B answers the natural way (an @mention of the asker): now it is answered
	post(map[string]any{"subscriber_id": "Dev B", "content": "@Lead agreed, the old one"})
	u = updates(page(held))
	require.Contains(t, u, qid)
	assert.Equal(t, []any{}, u[qid]["open"])
	assert.Equal(t, true, u[qid]["answered"])

	// the same rule as the question's own ask field
	resp, err := http.Get(base + "/messages/all?format=dashboard&limit=500")
	require.NoError(t, err)
	defer resp.Body.Close()
	var all map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&all))
	for _, m := range asSlice(all["messages"]) {
		if mm := m.(map[string]any); mm["id"] == qid {
			assert.Equal(t, u[qid], mm["ask"], "the update and the question's ask are one rule")
		}
	}

	// a page that holds the question itself (after_id before it) needs no update for it
	earlier := page(qid - 1)
	assert.NotContains(t, updates(earlier), qid, "a question in the page carries its own state")

	// the first page (no after_id) never has updates
	resp2, err := http.Get(base + "/messages/all?format=dashboard")
	require.NoError(t, err)
	defer resp2.Body.Close()
	var first map[string]any
	require.NoError(t, json.NewDecoder(resp2.Body).Decode(&first))
	assert.NotContains(t, first, "ask_updates")
}

func asSlice(v any) []any {
	s, _ := v.([]any)
	return s
}
