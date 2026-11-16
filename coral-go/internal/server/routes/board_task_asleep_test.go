package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17657 (from #17652): a task filed to a member that will not read the board now says so to whoever gave it, and names the members that are awake: the same role first.
func TestATaskForAMemberThatWillNotReadItNowSaysSoAndNamesWhoIsAwake(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.seat("Orchestrator", "Orchestrator", orchBoard, "claude", false, 1)
	r.seat("Dev Asleep", "Developer", orchBoard, "claude", true, 2)
	r.seat("Dev Awake", "Developer", orchBoard, "claude", false, 3)
	r.seat("Tester", "QA", orchBoard, "claude", false, 4)
	h := &BoardHandler{bs: r.h.bs, memberRest: MemberRestLookup(r.h.bs, r.ss)}

	assert.Equal(t, "Dev Asleep is asleep; the task waits until it wakes. Awake with the same role: Dev Awake (0 waiting).", h.assigneeRestWarning(ctx, orchBoard, "Dev Asleep"))
	assert.Equal(t, "", h.assigneeRestWarning(ctx, orchBoard, "Dev Awake"), "an awake member reads its task")
	assert.Equal(t, "", h.assigneeRestWarning(ctx, orchBoard, "Operator"), "the Operator is no agent")
	assert.Equal(t, "", h.assigneeRestWarning(ctx, orchBoard, ""), "no assignee")
	assert.Equal(t, "", (&BoardHandler{bs: r.h.bs}).assigneeRestWarning(ctx, orchBoard, "Dev Asleep"), "no lookup: no warning")
}

// The routes put the warning in their answer, beside the task's own fields (the CLI prints it).
func TestTheTaskRoutesCarryTheAsleepWarning(t *testing.T) {
	server, h := setupBoardTestServer(t)
	h.SetMemberRestLookup(func(_ context.Context, _, member string) string {
		if member == "Dev" {
			return restAsleep
		}
		return ""
	})
	base := server.URL + "/api/board/asleep-team"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator"}).Body.Close()
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Developer"}).Body.Close()
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Other", "job_title": "Developer"}).Body.Close()
	read := func(resp *http.Response) map[string]any {
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}

	made := read(postJSON(t, base+"/tasks", map[string]any{"subscriber_id": "Lead", "title": "For the sleeper", "assigned_to": "Dev"}))
	assert.Equal(t, "Dev is asleep; the task waits until it wakes.", made["warning"], "task add: %v", made)
	assert.Equal(t, "For the sleeper", made["title"], "the task's own fields are where they were")
	awake := read(postJSON(t, base+"/tasks", map[string]any{"subscriber_id": "Lead", "title": "For the awake", "assigned_to": "Other"}))
	assert.NotContains(t, awake, "warning", "an awake assignee: nothing added")

	moved := read(postJSON(t, base+"/tasks/"+fmt.Sprint(int64(awake["id"].(float64)))+"/reassign", map[string]any{"subscriber_id": "Lead", "assignee": "Dev"}))
	assert.Equal(t, "Dev is asleep; the task waits until it wakes.", moved["warning"], "task reassign: %v", moved)
}
