package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13224: coral-board wake <member> / sleep <member>: the Orchestrator's grant route had no command. What is sent, what is printed, and that the server's refusal (the switch off, a cap) is said as it gave it.
func TestWakeAndSleepCallTheGrantRoutesAndSayWhatHappened(t *testing.T) {
	gs := newGoalServer(t)
	gs.setReply("POST /api/board/team/agents/Dev A/wake", `{"ok":true,"woke":"Dev A"}`)
	gs.setReply("POST /api/board/team/agents/Dev A/sleep", `{"ok":true,"slept":"Dev A"}`)
	res := goalRun(t, gs, "wake", "Dev A")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Equal(t, "Woke Dev A; it resumes where it left off and is told to read the board first.\n", res.stdout)
	res = goalRun(t, gs, "sleep", "Dev A")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Equal(t, "Put Dev A to sleep.\n", res.stdout)
	reqs := gs.requests()
	require.Len(t, reqs, 2)
	assert.Contains(t, reqs[0], "POST /api/board/team/agents/Dev A/wake? ", "the member's name is one path segment")
	assert.Contains(t, reqs[1], "POST /api/board/team/agents/Dev A/sleep? ")

	// --board names another board; the flag may come before the member
	res = goalRun(t, gs, "wake", "--board", "other", "Dev")
	require.Equal(t, 0, res.code, res.stderr)
	assert.Contains(t, gs.requests()[2], "POST /api/board/other/agents/Dev/wake? ")
}

func TestWakeAndSleepNeedAMemberAndSayTheServersRefusal(t *testing.T) {
	gs := newGoalServer(t)
	for name, args := range map[string][]string{"no member": {"wake"}, "a flag only": {"sleep", "--board", "x"}} {
		res := goalRun(t, gs, args...)
		assert.NotEqual(t, 0, res.code, name)
		assert.Contains(t, res.stderr, "coral-board wake <member>", name)
	}
	assert.Empty(t, gs.requests(), "nothing is sent without a member")

	// the server's words are what is printed: the grant off, and the two caps
	for _, c := range []struct {
		status int
		body   string
		want   string
	}{
		{403, `{"code":"orchestrator_switch_off","message":"the Operator has not allowed this board's orchestrator to wake, sleep or start agents"}`, "has not allowed this board's orchestrator"},
		{429, `{"code":"orch_hourly_cap","message":"this board's orchestrator has used its 6 starts for this hour; try again later"}`, "6 starts for this hour"},
		{409, `{"code":"orch_live_cap","message":"this board already has 4 agents running, the most the Operator allows"}`, "already has 4 agents running"},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(c.body))
		}))
		gs2 := &goalServer{Server: srv, reply: map[string]string{}}
		res := goalRun(t, gs2, "wake", "Dev")
		srv.Close()
		assert.NotEqual(t, 0, res.code, c.want)
		assert.True(t, strings.Contains(res.stderr, c.want), "the refusal is said as the server gave it: %q", res.stderr)
		assert.Empty(t, res.stdout, "nothing is said to have happened")
	}
}

// QA Reviewer 2's SHOULD on #13224 (#13285): the member's name is one escaped path segment: a space is %20, a slash is %2F (it is not a second segment). The name the server answers with is cleaned before it is printed.
func TestWakeEscapesTheMemberNameInThePathAndCleansTheNameItPrints(t *testing.T) {
	var uris []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/health" {
			_, _ = w.Write([]byte(`{"status":"ok","version":"test"}`))
			return
		}
		uris = append(uris, r.RequestURI)
		_, _ = w.Write([]byte(`{"ok":true,"woke":"Dev\u001b[31m A"}`))
	}))
	defer srv.Close()
	gs := &goalServer{Server: srv, reply: map[string]string{}}
	res := goalRun(t, gs, "wake", "Dev A")
	require.Equal(t, 0, res.code, res.stderr)
	assert.NotContains(t, res.stdout, "\x1b", "the server's name is cleaned before it reaches the terminal")
	res = goalRun(t, gs, "sleep", "Dev/Ops")
	require.Equal(t, 0, res.code, res.stderr)
	require.Len(t, uris, 2)
	assert.Equal(t, "/api/board/team/agents/Dev%20A/wake", uris[0])
	assert.Equal(t, "/api/board/team/agents/Dev%2FOps/sleep", uris[1], "a slash is not a second path segment")
}

// The Orchestrator's tiny test on #13285: a board name with a space is one escaped path segment too.
func TestWakeEscapesABoardNameWithASpaceInThePath(t *testing.T) {
	var uris []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/health" {
			_, _ = w.Write([]byte(`{"status":"ok","version":"test"}`))
			return
		}
		uris = append(uris, r.RequestURI)
		_, _ = w.Write([]byte(`{"ok":true,"slept":"Dev"}`))
	}))
	defer srv.Close()
	gs := &goalServer{Server: srv, reply: map[string]string{}}
	res := goalRun(t, gs, "sleep", "--board", "my team?x", "Dev") // a space (Go would encode it anyway) and a question mark (it would start a query)
	require.Equal(t, 0, res.code, res.stderr)
	require.Len(t, uris, 1)
	assert.Equal(t, "/api/board/my%20team%3Fx/agents/Dev/sleep", uris[0], "the board name is one escaped segment: a space is %20 and a question mark %3F")
}
