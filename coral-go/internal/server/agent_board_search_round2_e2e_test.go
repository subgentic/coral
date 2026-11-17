package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// The second round of blind testers (#19448, goal #244): a singular source name, a refused state that names the right ones, the assignee on a task hit, a total that counts the tasks too,
// a goal's whole done-when in its snippet, and a reviewer's "Review #N" task listed after the real hits.
func TestAgentBoardSearchRoundTwoFindings(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	a, err := bs.CreateBoard(ctx, "team-r2", "Operator")
	require.NoError(t, err)
	doneWhen := "From an agent's shell the search finds a word that appears only in a task body, a goal outcome, a completion message and a past chat, " + strings.Repeat("padding words, ", 8) + "and the end of the sentence says zebra"
	_, err = bs.CreateGoal(ctx, a.ID, board.GoalInput{Title: "One search command", Outcome: "agents find things", DoneWhen: doneWhen, CreatedBy: "op"})
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, a.ID, "Fix the certificate", "the staging certificate expired", "high", "orch", "Developer experience")
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, a.ID, "Review #1: Fix the certificate", "review the staging certificate fix", "high", "Coral Task Queue", "QA Engineer")
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, a.ID, "Later work", "another staging certificate note", "low", "orch", "Developer experience")
	require.NoError(t, err)

	sid := "eeeeeeee-1105-4000-8000-0000000019b2"
	boardKey := a.ID
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &boardKey}))
	tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, a.ID, "Dev-cccc", "Dev", "claude-"+sid, nil, "all")
	require.NoError(t, err)

	get := func(params url.Values) (int, map[string]any) {
		req, _ := http.NewRequest("GET", ts.URL+"/api/agent/board/search?"+params.Encode(), nil)
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return resp.StatusCode, out
	}
	results := func(out map[string]any) []map[string]any {
		var rs []map[string]any
		for _, r := range out["results"].([]any) {
			rs = append(rs, r.(map[string]any))
		}
		return rs
	}

	// "goal" is read as goals; a task hit carries its assignee
	code, out := get(url.Values{"q": {"zebra"}, "source": {"goal"}})
	require.Equal(t, http.StatusOK, code)
	rs := results(out)
	require.Len(t, rs, 1)
	require.Contains(t, rs[0]["snippet"], "zebra", "the whole done-when, 300 characters at most, fits the snippet")
	code, out = get(url.Values{"q": {"staging certificate"}, "source": {"task"}})
	require.Equal(t, http.StatusOK, code)
	rs = results(out)
	require.Len(t, rs, 3)
	require.Equal(t, "Review #1: Fix the certificate", rs[2]["title"], "the reviewer's task comes after the real hits")
	require.Equal(t, "Developer experience", rs[0]["assignee"])
	require.EqualValues(t, 3, out["total"], "tasks count in the total")

	// the assignee filter is the member's name, in any case
	code, out = get(url.Values{"q": {"staging"}, "assignee": {"developer EXPERIENCE "}})
	require.Equal(t, http.StatusOK, code)
	require.Len(t, results(out), 2)

	// a state that is nothing is refused with the right ones named, never "no match"
	code, out = get(url.Values{"q": {"staging"}, "state": {"finished"}})
	require.Equal(t, http.StatusBadRequest, code)
	require.Contains(t, out["error"], "in_progress")
	require.Contains(t, out["error"], "proposed")
	code, _ = get(url.Values{"q": {"staging"}, "state": {"Completed"}})
	require.Equal(t, http.StatusOK, code, "a state in any case")
	code, out = get(url.Values{"q": {"staging"}, "source": {"nothing"}})
	require.Equal(t, http.StatusBadRequest, code)
	require.Contains(t, out["error"], "goals")
}

// Round 3 (#19476, from the prompt evals): "open" as a state, the near matches when no task or goal holds every word, which filter left nothing, and a goal's whole done-when.
func TestAgentBoardSearchRoundThreeHints(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)
	bs := srv.boardStore
	a, err := bs.CreateBoard(ctx, "team-r3", "Operator")
	require.NoError(t, err)
	_, err = bs.CreateGoal(ctx, a.ID, board.GoalInput{Title: "Reminders for any agent", Outcome: "agents keep checks", DoneWhen: "the Operator sets a recurring check and each fires on time", CreatedBy: "op"})
	require.NoError(t, err)
	open, err := bs.CreateTask(ctx, a.ID, "Wire the reminder", "open work on the reminder", "low", "orch", "Dana")
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, a.ID, "Old reminder", "finished reminder", "low", "orch", "Dana")
	require.NoError(t, err)
	msg := "done"
	_, err = bs.CompleteTask(ctx, a.ID, open.ID+1, "Dana", &msg)
	require.NoError(t, err)

	sid := "eeeeeeee-1105-4000-8000-0000000019b3"
	boardKey := a.ID
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &boardKey}))
	tok, err := srv.db.MintSessionToken(ctx, sid, "claude-"+sid)
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, a.ID, "Dev-dddd", "Dev", "claude-"+sid, nil, "all")
	require.NoError(t, err)
	get := func(params url.Values) map[string]any {
		req, _ := http.NewRequest("GET", ts.URL+"/api/agent/board/search?"+params.Encode(), nil)
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		require.Equal(t, http.StatusOK, resp.StatusCode, string(raw))
		var out map[string]any
		require.NoError(t, json.Unmarshal(raw, &out))
		return out
	}
	ids := func(out map[string]any, key string) []string {
		var got []string
		list, _ := out[key].([]any)
		for _, r := range list {
			m := r.(map[string]any)
			got = append(got, m["source"].(string)+":"+m["title"].(string))
		}
		return got
	}
	// open: the task still to do, not the finished one
	out := get(url.Values{"q": {"reminder"}, "source": {"tasks"}, "state": {"open"}})
	require.Equal(t, []string{"task:Wire the reminder"}, ids(out, "results"))
	// a goal hit carries its whole done-when
	out = get(url.Values{"q": {"reminders"}, "source": {"goals"}})
	require.Equal(t, "the Operator sets a recurring check and each fires on time", out["results"].([]any)[0].(map[string]any)["done_when"])
	// nothing holds every word: the near matches, with how many words each holds
	out = get(url.Values{"q": {"reminders ordinary team agents"}, "source": {"goals"}})
	require.Empty(t, out["results"])
	near := out["near_matches"].([]any)
	require.NotEmpty(t, near)
	require.EqualValues(t, 4, near[0].(map[string]any)["of"])
	require.GreaterOrEqual(t, near[0].(map[string]any)["matched"].(float64), float64(1))
	// a filter that left nothing is named by how many hits the search has without it
	out = get(url.Values{"q": {"reminder"}, "source": {"tasks"}, "state": {"blocked"}})
	require.Empty(t, out["results"])
	require.EqualValues(t, 2, out["without_filter"].(map[string]any)["state"])
}
