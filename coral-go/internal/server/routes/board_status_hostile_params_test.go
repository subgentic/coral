package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #9512: GET /api/board/{project}/status (#9471 TasksUnderReview, #9475 ListOpenTaskStates read its tasks): hostile project names, activity and subscriber_id, on a board that has open tasks with
// dependencies (a chain, a missing blocker, a blocker on another board), claimed and in flight: a 200 with its JSON body, a 4xx or a 404, never a 5xx.

var hostileProjects = []string{
	"b", "B", "no-such-board", "..", "../b", "b/../b", "b%2F..%2Fb", "%00", "b\x00", "' OR 1=1 --", "b'; DROP TABLE board_tasks; --", "%", "_", "*", "\\", "\"", "😀", "\u202eb", "b b", " b", "b ",
	strings.Repeat("b", 5000), strings.Repeat("%", 500), "con", "nul", "b.", "b:x", "projects", "remotes", "tasks",
}

var hostileActivity = []string{"", "1", "0", "true", "TRUE", "True", "false", "yes", "on", "-1", "x", "\x00", "'", strings.Repeat("1", 5000), "1&activity=0", "1,1"}

var hostileSubscribers = []string{"", "dev", "no-such", "' OR 1=1 --", "%", "_", "\\", "\x00", "😀", strings.Repeat("s", 5000), "../x", "a b", "AGENT"}

func TestBoardStatusRouteNeverFiveHundredOnHostileParams(t *testing.T) {
	srv, handler, terminal, ss, _ := archiveTestServer(t)
	ctx := context.Background()
	registerTerminalAgent(t, ss, terminal, archSID1, "b", false)
	registerTerminalAgent(t, ss, terminal, archSID2, "b", true)
	bs := handler.bs
	_, err := bs.Subscribe(ctx, "b", "dev", "Backend Dev", "tmux-dev", nil, "")
	require.NoError(t, err)
	// open tasks: a chain of blockers (two on one task), a blocker on another board, a claimed task and a draft
	a, err := bs.CreateTask(ctx, "b", "first", "", "high", "lead")
	require.NoError(t, err)
	b, err := bs.CreateTaskWithOpts(ctx, "b", "second", "", "medium", "lead", &board.CreateTaskOpts{BlockedBy: []board.TaskDep{{TaskID: a.ID}}, MaxDepth: 5})
	require.NoError(t, err)
	_, err = bs.CreateTaskWithOpts(ctx, "b", "third", "", "medium", "lead", &board.CreateTaskOpts{BlockedBy: []board.TaskDep{{TaskID: b.ID}, {TaskID: a.ID}}, MaxDepth: 5})
	require.NoError(t, err)
	other, err := bs.CreateTask(ctx, "other", "elsewhere", "", "low", "lead")
	require.NoError(t, err)
	_, err = bs.CreateTaskWithOpts(ctx, "b", "cross", "", "low", "lead", &board.CreateTaskOpts{BlockedBy: []board.TaskDep{{TaskID: other.ID, BoardID: "other"}}, MaxDepth: 5})
	require.NoError(t, err)
	_, err = bs.CreateTaskWithOpts(ctx, "b", "idea", "", "low", "lead", &board.CreateTaskOpts{Draft: true})
	require.NoError(t, err)
	_, err = bs.ClaimTask(ctx, "b", "dev")
	require.NoError(t, err)

	statusOf := func(project string, q url.Values) (int, []byte) {
		t.Helper()
		target := srv.URL + "/api/board/" + url.PathEscape(project) + "/status"
		if len(q) > 0 {
			target += "?" + q.Encode()
		}
		resp, err := http.Get(target)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	// the board as it is: a 200 with the sessions, the summary, and what the tasks say
	code, body := statusOf("b", nil)
	require.Equal(t, http.StatusOK, code, string(body))
	var ok struct {
		Agents  []map[string]any `json:"agents"`
		Summary map[string]int   `json:"summary"`
	}
	require.NoError(t, json.Unmarshal(body, &ok))
	assert.GreaterOrEqual(t, len(ok.Agents), 2, "the two registered agents and the subscriber")

	rng := rand.New(rand.NewSource(95122))
	pick := func(vs []string) string { return vs[rng.Intn(len(vs))] }
	checked, ok200, refused := 0, 0, 0
	check := func(project string, q url.Values) {
		t.Helper()
		code, body := statusOf(project, q)
		checked++
		require.Less(t, code, 500, "project %q %q: %s", project[:min(len(project), 80)], q.Encode()[:min(len(q.Encode()), 120)], string(body[:min(len(body), 300)]))
		if code == http.StatusOK {
			ok200++
			var any map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(body, &any), "a 200 is JSON")
		} else {
			refused++
		}
	}
	for _, p := range hostileProjects {
		check(p, nil)
		for _, act := range hostileActivity {
			check(p, url.Values{"activity": {act}})
		}
	}
	for _, act := range hostileActivity {
		for _, sub := range hostileSubscribers {
			check("b", url.Values{"activity": {act}, "subscriber_id": {sub}})
		}
	}
	for i := 0; i < 300; i++ {
		check(pick(hostileProjects), url.Values{"activity": {pick(hostileActivity)}, "subscriber_id": {pick(hostileSubscribers)}, fmt.Sprintf("x%d", i%5): {pick(hostileActivity)}})
	}
	assert.Greater(t, ok200, 100)
	t.Logf("%d hostile status requests: %d answered 200, %d refused or not found, none a 5xx", checked, ok200, refused)
}
