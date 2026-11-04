package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// #13420: coral-board agent wake|sleep <name> is the Orchestrator seat's way to POST /api/board/<board>/agents/<name>/wake|sleep. It escapes the name, prints what the server answered and the board's hourly limit, and
// passes a refusal (a non-seat agent, a limit used up) on as the server worded it.
func agentLifecycleStub(t *testing.T, status int, reply string) (gotMethod, gotRawPath *string) {
	t.Helper()
	var m, p string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m, p = r.Method, r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(reply))
	}))
	t.Cleanup(ts.Close)
	serverURL = ts.URL
	return &m, &p
}

func TestAgentWakeAndSleepCallTheSeatRoutesWithTheNameEscaped(t *testing.T) {
	isolateBoardEnv(t)
	saveState(&boardState{Project: "team a"})
	m, p := agentLifecycleStub(t, http.StatusOK, `{"ok":true,"woke":"UX/UX Engineer","max_per_hour":30}`)

	var out bytes.Buffer
	if err := runAgentLifecycle([]string{"wake", "UX/UX Engineer"}, &out); err != nil {
		t.Fatal(err)
	}
	if *m != "POST" || *p != "/api/board/team%20a/agents/UX%2FUX%20Engineer/wake" {
		t.Errorf("wake went to %s %s", *m, *p)
	}
	if !strings.Contains(out.String(), "Woke UX/UX Engineer") || !strings.Contains(out.String(), "30 launches and wakes an hour") {
		t.Errorf("output %q", out.String())
	}

	agentLifecycleStub(t, http.StatusOK, `{"ok":true,"slept":"Backend Dev"}`)
	out.Reset()
	if err := runAgentLifecycle([]string{"sleep", "Backend Dev"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Put Backend Dev to sleep") || strings.Contains(out.String(), "an hour") {
		t.Errorf("sleep output %q (a sleep is not counted against the hourly limit)", out.String())
	}
}

func TestAgentLifecycleUsesTheBoardFlagOverTheSeatsBoard(t *testing.T) {
	isolateBoardEnv(t)
	saveState(&boardState{Project: "mine"})
	_, p := agentLifecycleStub(t, http.StatusOK, `{"ok":true,"woke":"Dev"}`)
	if err := runAgentLifecycle([]string{"wake", "Dev", "--board", "other"}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if *p != "/api/board/other/agents/Dev/wake" {
		t.Errorf("path %s", *p)
	}
}

func TestAgentLifecycleRefusalsAreTheServersWords(t *testing.T) {
	isolateBoardEnv(t)
	saveState(&boardState{Project: "t"})
	agentLifecycleStub(t, http.StatusForbidden, `{"error":"only the orchestrator seat the Operator named may do this","code":"not_the_seat"}`)
	err := runAgentLifecycle([]string{"wake", "Dev"}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "only the orchestrator seat the Operator named may do this") {
		t.Errorf("a non-seat agent: %v", err)
	}
	agentLifecycleStub(t, http.StatusTooManyRequests, `{"error":"x","message":"this board's limit of 12 launches and wakes an hour is used up: wait, or the Operator can raise it","code":"board_hourly_limit"}`)
	err = runAgentLifecycle([]string{"wake", "Dev"}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "limit of 12 launches and wakes an hour") {
		t.Errorf("the hourly limit: %v", err)
	}
}

func TestAgentLifecycleUsageMistakesNeedNoServer(t *testing.T) {
	isolateBoardEnv(t)
	serverURL = "http://127.0.0.1:1" // closed: a usage mistake must be refused before any call
	for _, args := range [][]string{{}, {"wake"}, {"nap", "Dev"}, {"wake", "Dev", "Extra"}, {"sleep", "Operator", "--board"}} {
		if err := runAgentLifecycle(args, &bytes.Buffer{}); err == nil {
			t.Errorf("%v: no error", args)
		} else if _, ok := err.(errLinkUsage); !ok {
			t.Errorf("%v: %v is not a usage error", args, err)
		}
	}
}
