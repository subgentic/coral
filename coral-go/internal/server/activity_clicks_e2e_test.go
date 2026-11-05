package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
)

// #13609: the Operator's clicks in the Inbox and on the task pages are in the Activity record. Each case drives the real router as the person at this computer (no token) and then as an agent (its session token
// header), and reads the record: the person's click leaves one row of the named action, the agent's identical call leaves none.
func TestOperatorClicksAreInTheActivityRecord(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	_, err := srv.boardStore.Subscribe(ctx, "team", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	mk := func(title string) int64 {
		tk, err := srv.boardStore.CreateTask(ctx, "team", title, "body", "medium", "Lead", "Lead")
		require.NoError(t, err)
		return tk.ID
	}
	draft := func() int64 { // a task nobody holds starts as a draft
		tk, err := srv.boardStore.CreateTaskWithOpts(ctx, "team", "A draft", "body", "medium", "Lead", &board.CreateTaskOpts{Draft: true})
		require.NoError(t, err)
		return tk.ID
	}
	do := func(method, path, body string, hdr map[string]string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	rows := func() []board.OperatorAction {
		got, _, err := srv.boardStore.ActivityPage(ctx, board.ActivityFilter{Limit: board.ActivityMaxLimit})
		require.NoError(t, err)
		return got
	}
	type click struct {
		name, method, path, body string
		action, kind             string
		prep                     func(id int64) // before the click
	}
	cases := []func(id int64) click{
		func(id int64) click {
			return click{name: "create a task", method: "POST", path: "/api/board/team/tasks", body: `{"title":"New one","subscriber_id":"Operator"}`, action: board.ActTaskCreate, kind: "task"}
		},
		func(id int64) click {
			return click{name: "complete", method: "POST", path: tpath(id, "/complete"), body: `{"subscriber_id":"Operator"}`, action: board.ActTaskComplete, kind: "task"}
		},
		func(id int64) click {
			return click{name: "cancel", method: "POST", path: tpath(id, "/cancel"), body: `{"subscriber_id":"Operator"}`, action: board.ActTaskCancel, kind: "task"}
		},
		func(id int64) click {
			return click{name: "edit", method: "PATCH", path: tpath(id, ""), body: `{"subscriber_id":"Operator","title":"Renamed"}`, action: board.ActTaskEdit, kind: "task"}
		},
		func(id int64) click {
			return click{name: "amend", method: "PATCH", path: tpath(id, "/amend"), body: `{"subscriber_id":"Operator","base_revision":1,"reason":"clearer","changes":{"body":"more words"}}`, action: board.ActTaskEdit, kind: "task"}
		},
		func(id int64) click {
			return click{name: "remind", method: "POST", path: tpath(id, "/reminder") + "?subscriber_id=Operator", body: `{"interval_seconds":60}`, action: board.ActTaskRemind, kind: "task"}
		},
		func(id int64) click {
			return click{name: "park", method: "POST", path: tpath(id, "/park"), body: `{"subscriber_id":"Operator","reason":"later"}`, action: board.ActTaskPark, kind: "task"}
		},
		func(id int64) click {
			return click{name: "publish", method: "POST", path: tpath(draft(), "/publish"), body: `{"subscriber_id":"Operator"}`, action: board.ActTaskPublish, kind: "task"}
		},
	}
	for _, mkcase := range cases {
		id := mk("A task")
		c := mkcase(id)
		before := len(rows())
		code, out := do(c.method, c.path, c.body, map[string]string{"X-Coral-Session-Token": "not-a-real-token"})
		require.Len(t, rows(), before, "%s: an agent's call is no click (%d %s)", c.name, code, out)
		code, out = do(c.method, c.path, c.body, map[string]string{"Origin": ts.URL, "Sec-Fetch-Site": "same-origin"}) // the dashboard's own fetch
		require.Less(t, code, 300, "%s: %s", c.name, out)
		got := rows()
		require.Len(t, got, before+1, "%s: one row for the click", c.name)
		require.Equal(t, c.action, got[0].Action, c.name)
		require.Equal(t, c.kind, got[0].ItemKind, c.name)
		require.Equal(t, "local", got[0].Actor, c.name)
	}
}

func tpath(id int64, tail string) string {
	return "/api/board/team/tasks/" + itoa(id) + tail
}
