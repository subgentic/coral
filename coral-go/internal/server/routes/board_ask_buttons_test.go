package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
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

// A wake button names a member as the team lists it: spaces and a number in it are fine (#12600).
func TestAWakeButtonAcceptsAMemberWhoseNameHasSpacesAndANumber(t *testing.T) {
	post, _, _, base := buttonRig(t)
	for _, who := range []string{"QA Reviewer 2", "QA Engineer", "Frontend Dev"} {
		postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": who, "job_title": who}).Body.Close()
	}
	status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator Wake them?", "ask": true,
		"buttons": []string{"Wake QA Reviewer 2=wake:QA Reviewer 2", "Wake QA Engineer=wake:QA Engineer"}})
	require.Equal(t, http.StatusOK, status, out)
	status, out = post(map[string]any{"subscriber_id": "Lead", "content": "@Operator And this one?", "ask": true,
		"buttons": []string{"Wake Frontend Dev=wake:Frontend Dev", "Wake QA Reviewer 2=wake:QA Reviewer 2"}})
	require.Equal(t, http.StatusOK, status, out)
}

// A refused ask is nothing posted, so it is never one of the open asks with buttons (#12600): refusing more often than the cap leaves the agent able to ask.
func TestARefusedAskWithButtonsIsNotCountedAsOpen(t *testing.T) {
	post, count, _, _ := buttonRig(t)
	for i := 0; i < board10(); i++ {
		status, _ := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator refused", "ask": true, "buttons": []string{"Wake=wake:Nobody"}})
		require.Equal(t, http.StatusBadRequest, status)
	}
	assert.Zero(t, count())
	status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator now a good one", "ask": true, "buttons": []string{"Wake Dev=wake:Dev"}})
	assert.Equal(t, http.StatusOK, status, out)
}

func board10() int { return board.AskButtonsOpenMax + 2 }

// The likeliest reason a wake button was refused (#12600): the question's own text tags the agent to wake, which makes it a question to them as well. It is refused, and the refusal says which name and what to do.
func TestAWakeQuestionThatTagsTheAgentIsRefusedWithTheCause(t *testing.T) {
	post, count, _, _ := buttonRig(t)
	status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator @Dev is asleep: wake them?", "ask": true, "buttons": []string{"Wake Dev=wake:Dev"}})
	require.Equal(t, http.StatusBadRequest, status, out)
	msg, _ := out["error"].(string)
	assert.Contains(t, msg, "@Dev", "names the member the text tags")
	assert.Contains(t, msg, "without the @", "and what to do")
	assert.Zero(t, count())

	status, out = post(map[string]any{"subscriber_id": "Lead", "content": "@Operator Dev is asleep: wake them?", "ask": true, "buttons": []string{"Wake Dev=wake:Dev"}})
	assert.Equal(t, http.StatusOK, status, out)
}

// The board treats "Name:" as a tag of that member (chat style: "Dev: do X"), so a question that explains each wake with "UI Reviewer: ..." or "Wake UI Reviewer: ..." was a question to them too and its buttons
// were refused with no @ anywhere (#12600, the Orchestrator's three texts). A button question asks only the Operator, and only a real @ of another member refuses it.
func TestAColonAfterAMembersNameDoesNotTurnAButtonQuestionIntoAQuestionToThem(t *testing.T) {
	post, _, h, base := buttonRig(t)
	for _, who := range []string{"UI Reviewer", "QA Engineer"} {
		postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": who, "job_title": who}).Body.Close()
	}
	for _, c := range []string{
		"@Operator Two wakes, please.\nUI Reviewer: the provider-cards review and your Dismiss button.\nQA Engineer: takes half of the queued reviews.",
		"@Operator Wake UI Reviewer: the provider-cards review and your Dismiss button.",
		"@Operator Wake QA Engineer — it takes half of the queued reviews.",
	} {
		status, out := post(map[string]any{"subscriber_id": "Lead", "content": c, "ask": true, "buttons": []string{"Wake UI Reviewer=wake:UI Reviewer", "Wake QA Engineer=wake:QA Engineer"}})
		require.Equal(t, http.StatusOK, status, "%q: %v", c, out)
		ask, _ := out["ask"].(map[string]any)
		assert.Equal(t, []any{"Operator"}, ask["to"], "the question is to the Operator alone, not to the members named with a colon")
		_ = h
	}
	status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator @UI Reviewer wake you?", "ask": true, "buttons": []string{"Wake UI Reviewer=wake:UI Reviewer"}})
	assert.Equal(t, http.StatusBadRequest, status, "a real @ of another member is still refused: %v", out)
}

// #12938: a wake button names a member by the name the board knows, colon, slash and spaces included; anything that is not a member is still refused, with the name in the reason.
func TestAWakeButtonAcceptsMemberNamesWithAColonASlashOrSpaces(t *testing.T) {
	post, _, _, base := buttonRig(t)
	for _, who := range []string{"Security: Reviewer 2", "UI/UX", "Go Backend Developer"} {
		postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": who, "job_title": who}).Body.Close()
	}
	for _, spec := range []string{"Wake=wake:Security: Reviewer 2", "Wake=wake:UI/UX", "Wake Go Backend=wake:Go Backend Developer"} {
		status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator ok? " + spec, "ask": true, "buttons": []string{spec}})
		assert.Equal(t, http.StatusOK, status, spec+": %v", out)
	}
	status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator who?", "ask": true, "buttons": []string{"Wake=wake:UI/Nobody"}})
	assert.Equal(t, http.StatusBadRequest, status)
	assert.Contains(t, out["error"], "UI/Nobody is not a member of this team", "a non-member is refused, named")
	assert.Contains(t, out["error"], "button 1")
	// A trailing colon cannot be part of a member's name (#11687): refused, with what was probably meant.
	status, out = post(map[string]any{"subscriber_id": "Lead", "content": "@Operator who?", "ask": true, "buttons": []string{"Wake=wake:Go Backend Developer:"}})
	assert.Equal(t, http.StatusBadRequest, status)
	assert.Contains(t, out["error"], `did you mean "Go Backend Developer"?`)
	status, out = post(map[string]any{"subscriber_id": "Lead", "content": "@Operator who?", "ask": true, "buttons": []string{"Wake=wake:Dev (x):"}}) // a closing bracket is part of a name (#12953)
	assert.Equal(t, http.StatusBadRequest, status)
	assert.Contains(t, out["error"], `did you mean "Dev (x)"?`)
}
