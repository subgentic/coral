package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
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
		code, out := do(c.method, c.path, c.body, map[string]string{store.SessionTokenHeader: "not-a-real-token"})
		require.Len(t, rows(), before, "%s: an agent's call is no click (%d %s)", c.name, code, out)
		code, out = do(c.method, c.path, c.body, map[string]string{"Origin": ts.URL, "Sec-Fetch-Site": "same-origin"}) // the dashboard's own fetch
		require.Less(t, code, 300, "%s: %s", c.name, out)
		got := rows()
		require.Len(t, got, before+1, "%s: one row for the click", c.name)
		require.Equal(t, c.action, got[0].Action, c.name)
		require.Equal(t, c.kind, got[0].ItemKind, c.name)
		require.Equal(t, "local", got[0].Actor, c.name)
		if c.action != board.ActTaskCreate { // the row names the task by its stored title (a create has no id yet)
			require.Contains(t, []string{"A task", "A draft", "Renamed"}, got[0].Title, c.name)
		}
	}
}

func tpath(id int64, tail string) string {
	return "/api/board/team/tasks/" + itoa(id) + tail
}

// #13609 slice 2: the rest of the Inbox, Saved, Chats and Goals clicks, through the real router, as the person and then as an agent.
func TestMoreOperatorClicksAreInTheActivityRecord(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	_, err := srv.boardStore.Subscribe(ctx, "team", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	msg, err := srv.boardStore.PostMessage(ctx, "team", "Lead", "a note worth keeping", nil)
	require.NoError(t, err)
	goal, err := srv.boardStore.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship it", Outcome: "o", DoneWhen: "d", CreatedBy: "Lead"})
	require.NoError(t, err)
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
	person := map[string]string{"Origin": ts.URL, "Sec-Fetch-Site": "same-origin"}
	type click struct {
		name, method, path, body string
		hdr                      map[string]string
		action, kind             string
	}
	saved := func() string { // the bookmark's id, once added
		code, out := do("GET", "/api/saved", "", person)
		require.Less(t, code, 300, out)
		var l struct {
			Items []struct {
				ID int64 `json:"id"`
			} `json:"items"`
		}
		require.NoError(t, json.Unmarshal([]byte(out), &l))
		require.NotEmpty(t, l.Items, out)
		return itoa(l.Items[0].ID)
	}
	cases := []func() click{
		func() click {
			return click{name: "new goal", method: "POST", path: "/api/board/team/goals", body: `{"subscriber_id":"Operator","title":"A new goal","outcome":"o","done_when":"d"}`, action: board.ActGoalCreate, kind: "goal"}
		},
		func() click {
			return click{name: "reopen a goal", method: "PATCH", path: "/api/board/team/goals/" + itoa(goal.ID), body: `{"subscriber_id":"Operator","state":"active"}`, action: board.ActGoalEdit, kind: "goal"}
		},
		func() click {
			return click{name: "bookmark a message", method: "POST", path: "/api/saved", body: `{"kind":"board","ref":"team","key":"` + itoa(msg.ID) + `","title":"a note","snippet":"a note worth keeping","team":"team","author":"Lead"}`, action: board.ActSavedAdd, kind: "message"}
		},
		func() click {
			return click{name: "saved Done", method: "PATCH", path: "/api/saved/" + saved(), body: `{"done":true}`, action: board.ActSavedUpdate, kind: "message"}
		},
		func() click {
			return click{name: "saved Remove", method: "DELETE", path: "/api/saved/" + saved(), body: ``, action: board.ActSavedRemove, kind: "message"}
		},
		func() click {
			return click{name: "star a chat", method: "PATCH", path: "/api/sessions/history/board%3Ateam/flags", body: `{"starred":true}`, action: board.ActChatFlag, kind: "chat"}
		},
		func() click {
			return click{name: "dismiss a welcome item", method: "PUT", path: "/api/settings", body: `{"inbox_welcome":"off"}`, action: board.ActInboxHide, kind: "setting"}
		},
		func() click {
			return click{name: "a welcome item done", method: "PUT", path: "/api/settings", body: `{"inbox_welcome_done":"tour"}`, action: board.ActInboxHide, kind: "setting"}
		},
		func() click {
			return click{name: "dismiss a goal-looks-done row", method: "PUT", path: "/api/settings", body: `{"goal_done_hidden":"[]"}`, action: board.ActInboxHide, kind: "setting"}
		},
	}
	for _, mk := range cases {
		c := mk()
		before := len(rows())
		code, out := do(c.method, c.path, c.body, map[string]string{store.SessionTokenHeader: "not-a-real-token"})
		require.Len(t, rows(), before, "%s: an agent's call is no click (%d %s)", c.name, code, out)
		code, out = do(c.method, c.path, c.body, person)
		require.Less(t, code, 300, "%s: %s", c.name, out)
		got := rows()
		require.Len(t, got, before+1, "%s: one row for the click", c.name)
		require.Equal(t, c.action, got[0].Action, c.name)
		require.Equal(t, c.kind, got[0].ItemKind, c.name)
	}
}

// #13621: a row links to what its click made. The new goal's, task's and bookmark's numbers are in the rows of goal_create, task_create and saved_add, and a failed run's row says whether it was a job's or a workflow's. Each is
// read back from GET /api/activity, the way the Inbox's Activity folder reads it.
func TestRowsNameWhatTheirClickMadeAndTheKindOfRun(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	_, err := srv.boardStore.Subscribe(ctx, "team", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	msg, err := srv.boardStore.PostMessage(ctx, "team", "Lead", "a note worth keeping", nil)
	require.NoError(t, err)
	person := map[string]string{"Origin": ts.URL, "Sec-Fetch-Site": "same-origin"}
	do := func(method, path, body string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		for k, v := range person {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}
	idOf := func(out string) string {
		var v struct {
			ID int64 `json:"id"`
		}
		require.NoError(t, json.Unmarshal([]byte(out), &v), out)
		require.NotZero(t, v.ID, out)
		return itoa(v.ID)
	}
	code, out := do("POST", "/api/board/team/goals", `{"subscriber_id":"Operator","title":"A new goal","outcome":"o","done_when":"d"}`)
	require.Less(t, code, 300, out)
	goalID := idOf(out)
	code, out = do("POST", "/api/board/team/tasks", `{"title":"New one","subscriber_id":"Operator"}`)
	require.Less(t, code, 300, out)
	taskID := idOf(out)
	code, out = do("POST", "/api/saved", `{"kind":"board","ref":"team","key":"`+itoa(msg.ID)+`","title":"a note","snippet":"a note worth keeping","team":"team","author":"Lead"}`)
	require.Less(t, code, 300, out)
	savedID := idOf(out)
	job, err := store.NewScheduleStore(srv.db).CreateScheduledJob(ctx, &store.ScheduledJob{Name: "j", CronExpr: "* * * * *", RepoPath: "/tmp", Prompt: "p", Enabled: 1})
	require.NoError(t, err)
	_, err = store.NewScheduleStore(srv.db).CreateScheduledRun(ctx, job.ID, "2026-10-26T00:00:00Z", "failed") // so the two runs' numbers differ: a swapped kind cannot pass by luck
	require.NoError(t, err)
	jobRun, err := store.NewScheduleStore(srv.db).CreateScheduledRun(ctx, job.ID, "2026-10-27T00:00:00Z", "failed")
	require.NoError(t, err)
	require.NotEqual(t, jobRun, int64(1))
	for jobRun == job.ID { // the job's number and the run's differ, so a swapped pair cannot pass by luck (the server seeds an example job)
		jobRun, err = store.NewScheduleStore(srv.db).CreateScheduledRun(ctx, job.ID, "2026-10-28T00:00:00Z", "failed")
		require.NoError(t, err)
	}
	wf, err := store.NewWorkflowStore(srv.db).CreateWorkflow(ctx, &store.Workflow{Name: "w", StepsJSON: `[]`, DefaultAgentJSON: "{}", BaseBranch: "main", MaxDurationS: 60, Enabled: 1})
	require.NoError(t, err)
	wfRun, err := store.NewWorkflowStore(srv.db).CreateWorkflowRun(ctx, wf.ID, "api", nil)
	require.NoError(t, err)
	for _, p := range []string{"/api/workflows/runs/" + itoa(wfRun.ID) + "/seen", "/api/scheduled/runs/" + itoa(jobRun) + "/seen"} {
		code, out = do("POST", p, ``)
		require.Less(t, code, 300, p+" "+out)
	}
	code, out = do("GET", "/api/activity", "")
	require.Equal(t, http.StatusOK, code, out)
	var list struct {
		Actions []board.OperatorAction `json:"actions"`
	}
	require.NoError(t, json.Unmarshal([]byte(out), &list))
	got := map[string]board.OperatorAction{}
	for _, a := range list.Actions {
		got[a.Action+"/"+a.ItemKind] = a
	}
	require.Equal(t, goalID, got[board.ActGoalCreate+"/goal"].ItemID, "the new goal's number")
	require.Equal(t, "A new goal", got[board.ActGoalCreate+"/goal"].Title)
	require.Equal(t, taskID, got[board.ActTaskCreate+"/task"].ItemID, "the new task's number")
	require.Equal(t, "New one", got[board.ActTaskCreate+"/task"].Title)
	require.Equal(t, savedID, got[board.ActSavedAdd+"/message"].ItemID, "the new bookmark's number")
	require.Equal(t, itoa(wfRun.ID), got[board.ActRunSeen+"/workflow_run"].ItemID, "a workflow's run")
	require.Equal(t, itoa(job.ID)+":"+itoa(jobRun), got[board.ActRunSeen+"/job_run"].ItemID, "an automation job's run: the job's number, a colon, the run's number (#13626)")
	require.Equal(t, "j", got[board.ActRunSeen+"/job_run"].Title, "the job's name")
	oneOff, err := store.NewScheduleStore(srv.db).CreateScheduledJob(ctx, &store.ScheduledJob{Name: "__oneshot__", CronExpr: "* * * * *", RepoPath: "/tmp", Prompt: "p", Enabled: 1})
	require.NoError(t, err)
	for _, tc := range []struct {
		jobID         int64
		display, want string
	}{
		{oneOff.ID, "Check release readiness", "Check release readiness"},
		{oneOff.ID, "", "Job " + itoa(oneOff.ID)},
		{job.ID, "A named scheduled run", "A named scheduled run"},
	} {
		runID, err := store.NewScheduleStore(srv.db).CreateScheduledRun(ctx, tc.jobID, "2026-10-29T00:00:00Z", "failed")
		require.NoError(t, err)
		if tc.display != "" {
			_, err = srv.db.ExecContext(ctx, "UPDATE scheduled_runs SET display_name=? WHERE id=?", tc.display, runID)
			require.NoError(t, err)
		}
		code, out = do("POST", "/api/scheduled/runs/"+itoa(runID)+"/seen", "")
		require.Equal(t, http.StatusOK, code, out)
		code, out = do("GET", "/api/activity", "")
		require.Equal(t, http.StatusOK, code, out)
		require.NoError(t, json.Unmarshal([]byte(out), &list))
		key := itoa(tc.jobID) + ":" + itoa(runID)
		found := false
		for _, a := range list.Actions {
			if a.ItemKind == "job_run" && a.ItemID == key {
				require.Equal(t, tc.want, a.Title, "Activity uses the Recent runs display-name precedence")
				found = true
			}
		}
		require.True(t, found, key)
	}

}
