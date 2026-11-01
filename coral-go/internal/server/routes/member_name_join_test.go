package routes

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11687: a name that starts or ends with punctuation is refused at the join (the repro of coral-hub's bug), and a post that would reach the shorter member while a member joined earlier with punctuation exists is refused naming it.
func TestJoinRefusesANameWithPunctuationAtAnEnd(t *testing.T) {
	server, _ := setupBoardTestServer(t)
	call := goalCall(t, server.URL)
	join := func(id, title string) (int, map[string]any) {
		return call("POST", "/api/board/team/subscribe", map[string]any{"subscriber_id": id, "job_title": title, "session_name": "claude-" + id})
	}
	code, _ := join("lead", "Orchestrator")
	require.Equal(t, http.StatusOK, code)
	code, _ = join("sec", "Security Reviewer")
	require.Equal(t, http.StatusOK, code)
	for _, bad := range [][2]string{{"sec2", "Security Reviewer 2:"}, {"sec2:", "Security Reviewer 2"}, {"sec2", ".Reviewer"}, {"sec2", "(Reviewer)"}} {
		code, out := join(bad[0], bad[1])
		assert.Equal(t, http.StatusBadRequest, code, "%v", bad)
		assert.Equal(t, "invalid_member_name", out["code"], "%v", bad)
	}
	code, out := join("sec2", "Security Reviewer 2")
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, _ = join("sec3", "Reviewer, 3rd")
	assert.Equal(t, http.StatusOK, code, "punctuation inside a name is fine")

	// The shorter member was reached by "@Security Reviewer 2" before: now the exact longer name is a member and is reached whole, nothing goes astray.
	code, out = call("POST", "/api/board/team/messages", map[string]any{"subscriber_id": "lead", "content": "@Security Reviewer 2 please look"})
	assert.Equal(t, http.StatusOK, code, "%v", out)
}

func TestAPostThatWouldReachTheShorterMemberIsRefusedNamingTheNearOne(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := t.Context()
	for _, m := range [][2]string{{"lead", "Orchestrator"}, {"sec", "Security Reviewer"}, {"sec2", "Security Reviewer 2:"}} { // the last joined before the join refused such a name
		_, err := h.bs.Subscribe(ctx, "team", m[0], m[1], "claude-"+m[0], nil, "mentions")
		require.NoError(t, err)
	}
	call := goalCall(t, server.URL)
	code, out := call("POST", "/api/board/team/messages", map[string]any{"subscriber_id": "lead", "content": "@Security Reviewer 2 please look at the patch"})
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Contains(t, fmt.Sprint(out), "Security Reviewer 2:", "the refusal names the near match")
	code, out = call("POST", "/api/board/team/messages", map[string]any{"subscriber_id": "lead", "content": "@Security Reviewer please look at the patch"})
	assert.Equal(t, http.StatusOK, code, "the shorter member by its own name is fine: %v", out)
}
