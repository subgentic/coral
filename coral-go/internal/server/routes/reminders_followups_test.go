package routes

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19245 (Security's follow-ups on #19162).

// An agent may mark done any reminder for it but cancels only its own; the person and the team's seat cancel the rest.
func TestReminderAnAgentCancelsOnlyItsOwn(t *testing.T) {
	rr := newRemRig(t)
	rr.seat(true) // Dev (session 1) is also the seat; Helper (2) is an ordinary member
	_, set := rr.once("person", "Helper", "Operator's for Helper", time.Hour)
	setID := id64(set)
	code, out := rr.call("POST", "/api/reminders", "agent:2", map[string]any{"text": "Mine", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC"})
	require.Equal(t, 201, code, out)
	ownID := id64(out)

	code, body := rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", setID), "agent:2", nil)
	assert.Equal(t, 403, code, "the Operator's reminder is not the agent's to cancel: %v", body)
	_, list := rr.call("GET", "/api/reminders", "agent:2", nil)
	assert.Len(t, list["reminders"], 2, "nothing was removed")
	code, _ = rr.call("POST", fmt.Sprintf("/api/reminders/%d/done", setID), "agent:2", nil)
	assert.Equal(t, 200, code, "it may mark it done")

	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", ownID), "agent:2", nil)
	assert.Equal(t, 200, code, "its own it may cancel")
	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", setID), "agent:1", nil)
	assert.Equal(t, 200, code, "the seat cancels the Operator's")

	_, set = rr.once("person", "Helper", "Another", time.Hour)
	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", id64(set)), "person", nil)
	assert.Equal(t, 200, code, "the person cancels any")

	// a reminder the seat set for the agent is also not the agent's to cancel
	_, bySeat := rr.call("POST", "/api/reminders", "agent:1", map[string]any{"text": "From the seat", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC", "to": "Helper"})
	require.NotZero(t, id64(bySeat), bySeat)
	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", id64(bySeat)), "agent:2", nil)
	assert.Equal(t, 403, code)
}

// The limit check and the save are one step: parallel requests cannot all pass the cap.
func TestReminderTheCapHoldsUnderParallelRequests(t *testing.T) {
	rr := newRemRig(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	made := 0
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			code, _ := rr.call("POST", "/api/reminders", "agent:1", map[string]any{"text": fmt.Sprintf("n%d", i), "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC"})
			if code == 201 {
				mu.Lock()
				made++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	assert.Equal(t, maxAgentReminders, made, "exactly the cap, however many arrive at once")
}

// A one-time reminder missed while the computer was off fires on the next start, once; a fired one cannot re-arm for next year.
func TestReminderAMissedOneTimeFiresOnTheNextStartAndCannotReArm(t *testing.T) {
	rr := newRemRig(t)
	ctx := context.Background()
	code, out := rr.once("person", "Dev", "Missed one", time.Hour)
	require.Equal(t, 201, code, out)
	rid := id64(out)
	check, _ := rr.ch.sched.ChiefCheck(ctx, rid)
	job, _ := rr.ch.sched.GetScheduledJob(ctx, check.JobID)

	rr.ch.now = func() time.Time { return rr.now.Add(3 * 24 * time.Hour) } // off for three days: past the scheduler's one-day look-back
	rr.ch.Poll(ctx)
	msgs := rr.messages()
	require.Len(t, msgs, 1, "it fires on the next start")
	assert.Contains(t, msgs[0], "Missed one")
	rr.ch.Poll(ctx)
	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 9)) // the scheduler's own slot for it: the same trigger
	assert.Len(t, rr.messages(), 1, "once")
	after, _ := rr.ch.sched.ChiefCheck(ctx, rid)
	assert.False(t, after.Enabled, "switched off")

	code, _ = rr.call("POST", fmt.Sprintf("/api/reminders/%d/done", rid), "agent:1", nil) // resolved, so a new trigger could begin
	require.Equal(t, 200, code)
	// someone switches the job back on and its cron line comes round again next year
	_, err := rr.h.db.ExecContext(ctx, `UPDATE scheduled_jobs SET enabled=1 WHERE id=?`, check.JobID)
	require.NoError(t, err)
	_, err = rr.h.db.ExecContext(ctx, `DELETE FROM chief_run_keys WHERE check_id=?`, rid)
	require.NoError(t, err)
	rr.ch.now = func() time.Time { return rr.now.AddDate(1, 0, 0) }
	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 10))
	assert.Len(t, rr.messages(), 1, "a reminder never fires for a year other than its own")
	off, _ := rr.ch.sched.ChiefCheck(ctx, rid)
	assert.False(t, off.Enabled)
}
