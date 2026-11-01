package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Buttons on a question to @Operator (#11643): declared on the post, checked by the server against a closed grammar and against the team, stored, listed for the Operator; run by nobody until they click.

func buttonRig(t *testing.T) (post func(map[string]any) (int, map[string]any), count func() int, h *BoardHandler, base string) {
	server, h := setupBoardTestServer(t)
	base = server.URL + "/api/board/btnboard"
	for _, who := range []string{"Operator", "Lead", "Dev"} {
		postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": who, "job_title": who}).Body.Close()
	}
	post = func(payload map[string]any) (int, map[string]any) {
		resp := postJSON(t, base+"/messages", payload)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	return post, func() int { return countMessages(t, base) }, h, base
}

func TestAskButtonsAreStoredAndListedForTheOperator(t *testing.T) {
	post, _, h, _ := buttonRig(t)
	status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator Ship the release?", "ask": true, "buttons": []string{"Yes, ship it=reply", "New agent=open:new-agent", "Wake Dev=wake:Dev"}})
	require.Equal(t, http.StatusOK, status, out)
	got, err := h.bs.AskButtonsOf(context.Background(), "btnboard", []int64{int64(out["id"].(float64))})
	require.NoError(t, err)
	require.Len(t, got[int64(out["id"].(float64))], 3)
	assert.Equal(t, "Yes, ship it", got[int64(out["id"].(float64))][0].Label)
	assert.Equal(t, "pending", got[int64(out["id"].(float64))][0].State)

	code, rows, _ := readOperatorAsks(t, h, asPerson)
	require.Equal(t, http.StatusOK, code)
	require.Len(t, rows, 1)
	btns, _ := rows[0]["buttons"].([]any)
	require.Len(t, btns, 3, "the Operator's list carries the declared buttons")
	assert.Equal(t, "reply", btns[0].(map[string]any)["action"])
}

func TestAskButtonsAreRefusedWhereTheyDoNotBelongAndNothingIsPosted(t *testing.T) {
	post, count, _, _ := buttonRig(t)
	d := strings.Repeat("ab", 32)
	for name, p := range map[string]map[string]any{
		"not an ask":                         {"subscriber_id": "Lead", "content": "@Operator hello", "buttons": []string{"Yes=reply"}},
		"an ask to another member":           {"subscriber_id": "Lead", "content": "@Dev ok?", "ask": true, "buttons": []string{"Yes=reply"}},
		"an ask to the Operator and another": {"subscriber_id": "Lead", "content": "@Operator @Dev ok?", "ask": true, "buttons": []string{"Yes=reply"}},
		"the Operator as poster":             {"subscriber_id": "Operator", "content": "@Lead ok?", "ask": true, "buttons": []string{"Yes=reply"}},
		"four buttons":                       {"subscriber_id": "Lead", "content": "@Operator ok?", "ask": true, "buttons": []string{"A=reply", "B=reply2", "C=reply", "D=reply"}},
		"a bad shape":                        {"subscriber_id": "Lead", "content": "@Operator ok?", "ask": true, "buttons": []string{"Yes=reply", "Run it=run:rm -rf /"}},
		"a label with an @":                  {"subscriber_id": "Lead", "content": "@Operator ok?", "ask": true, "buttons": []string{"Tell @Dev=reply"}},
		"a task of no team":                  {"subscriber_id": "Lead", "content": "@Operator ok?", "ask": true, "buttons": []string{"Task=open:task:99"}},
		"an artifact of no team":             {"subscriber_id": "Lead", "content": "@Operator ok?", "ask": true, "buttons": []string{"Plan=open:artifact:" + d}},
		"a wake of a non-member":             {"subscriber_id": "Lead", "content": "@Operator ok?", "ask": true, "buttons": []string{"Wake=wake:Nobody"}},
		"a wake of the Operator":             {"subscriber_id": "Lead", "content": "@Operator ok?", "ask": true, "buttons": []string{"Wake=wake:Operator"}},
	} {
		status, out := post(p)
		assert.Equal(t, http.StatusBadRequest, status, name+": %v", out)
	}
	assert.Zero(t, count(), "a refused post leaves nothing behind")
}

func TestAnAgentMayHaveTenAsksWithButtonsOpen(t *testing.T) {
	post, _, _, _ := buttonRig(t)
	for i := 0; i < 10; i++ {
		status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator question " + string(rune('a'+i)), "ask": true, "buttons": []string{"Yes=reply"}})
		require.Equal(t, http.StatusOK, status, out)
	}
	status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator one more", "ask": true, "buttons": []string{"Yes=reply"}})
	assert.Equal(t, http.StatusTooManyRequests, status, out)
	status, _ = post(map[string]any{"subscriber_id": "Dev", "content": "@Operator mine", "ask": true, "buttons": []string{"Yes=reply"}})
	assert.Equal(t, http.StatusOK, status, "the cap is per agent")
	status, _ = post(map[string]any{"subscriber_id": "Lead", "content": "@Operator plain question", "ask": true})
	assert.Equal(t, http.StatusOK, status, "a question with no buttons is not counted")
}
