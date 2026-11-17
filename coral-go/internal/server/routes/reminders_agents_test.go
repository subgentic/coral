package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #19288: Settings shows each agent's reminder count and a switch that turns that agent's reminders off and back on without deleting them. The person's only.

// toDev is what Dev was told: the rig's other agent has a reminder of its own that fires too.
func (rr *remRig) toDev() []string {
	var out []string
	for _, m := range rr.messages() {
		if strings.HasPrefix(m, "@Dev ") {
			out = append(out, m)
		}
	}
	return out
}

func agentRow(t *testing.T, out map[string]any, name string) map[string]any {
	t.Helper()
	rows, _ := out["agents"].([]any)
	for _, r := range rows {
		if m, _ := r.(map[string]any); m["name"] == name {
			return m
		}
	}
	t.Fatalf("no row for %s in %v", name, out)
	return nil
}

func TestReminderAgentsListsCountsAndTheNextFireTime(t *testing.T) {
	rr := newRemRig(t)
	rr.once("person", "Dev", "Later", 3*time.Hour)
	rr.once("person", "Dev", "Sooner", time.Hour)
	_, out := rr.call("GET", "/api/reminders/agents?board=team-a", "person", nil)
	dev, helper := agentRow(t, out, "Dev"), agentRow(t, out, "Helper")
	assert.EqualValues(t, 2, dev["count"])
	assert.EqualValues(t, 2, dev["active"])
	assert.Equal(t, rr.now.Add(time.Hour).UTC().Format(time.RFC3339), dev["next_at"], "the soonest one")
	assert.EqualValues(t, 0, helper["count"], "a member with none is listed with none")
	assert.Equal(t, "", helper["next_at"])
}

func TestReminderAgentSwitchIsThePersonsAndNotThroughTheHub(t *testing.T) {
	rr := newRemRig(t)
	rr.once("person", "Dev", "x", time.Hour)
	body := map[string]any{"board": "team-a", "on": false}
	path := "/api/reminders/agents/" + sendSid(1) + "/switch"
	for _, as := range []string{"agent:1", "agent:2", ""} {
		code, _ := rr.call("POST", path, as, body)
		assert.Equal(t, 403, code, "caller %q", as)
		code, _ = rr.call("GET", "/api/reminders/agents?board=team-a", as, nil)
		assert.Equal(t, 403, code, "the list is the person's too: %q", as)
	}
	code, _ := rr.call("POST", path, "person", body, tunnel.ViaHeader, "1")
	assert.Equal(t, 404, code, "not through the Hub")
	code, _ = rr.call("GET", "/api/reminders/agents?board=team-a", "person", nil, tunnel.ViaHeader, "1")
	assert.Equal(t, 404, code)
	_, out := rr.call("GET", "/api/reminders/agents?board=team-a", "person", nil)
	assert.EqualValues(t, 1, agentRow(t, out, "Dev")["active"], "nothing changed")
}

func TestReminderAgentSwitchOffKeepsThemSilentAndOnBringsThemBack(t *testing.T) {
	rr := newRemRig(t)
	ctx := context.Background()
	_, once := rr.once("person", "Dev", "Missed while off", time.Hour)
	_, rec := rr.call("POST", "/api/reminders", "agent:1", map[string]any{"text": "Check CI", "kind": "every", "every_minutes": 15, "timezone": "UTC"})
	_, other := rr.once("person", "Helper", "Helper's", time.Hour)
	path := "/api/reminders/agents/" + sendSid(1) + "/switch"

	code, out := rr.call("POST", path, "person", map[string]any{"board": "team-a", "on": false})
	require.Equal(t, 200, code, out)
	assert.EqualValues(t, 2, out["changed"])
	_, list := rr.call("GET", "/api/reminders/agents?board=team-a", "person", nil)
	dev := agentRow(t, list, "Dev")
	assert.EqualValues(t, 2, dev["count"], "nothing is deleted")
	assert.EqualValues(t, 0, dev["active"])
	assert.Equal(t, "", dev["next_at"])
	assert.EqualValues(t, 1, agentRow(t, list, "Helper")["active"], "another agent is untouched")

	rec1, _ := rr.ch.sched.ChiefCheck(ctx, id64(rec))
	job, _ := rr.ch.sched.GetScheduledJob(ctx, rec1.JobID)
	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 1))
	assert.Empty(t, rr.toDev(), "a switched-off agent is told nothing")

	rr.ch.now = func() time.Time { return rr.now.Add(2 * time.Hour) } // the one-time reminder's time passes while it is off
	rr.ch.Poll(ctx)
	assert.Empty(t, rr.toDev())

	code, _ = rr.call("POST", path, "person", map[string]any{"board": "team-a", "on": true})
	require.Equal(t, 200, code)
	rr.ch.Poll(ctx)
	msgs := rr.toDev()
	require.Len(t, msgs, 1, "back on: the missed one-time reminder is told once")
	assert.Contains(t, msgs[0], "Missed while off")
	_ = once
	_ = other
	_, list = rr.call("GET", "/api/reminders/agents?board=team-a", "person", nil)
	assert.EqualValues(t, 1, agentRow(t, list, "Dev")["count"], "the fired one-time is no longer to come")
	assert.Equal(t, fmt.Sprint(1), fmt.Sprint(agentRow(t, list, "Dev")["active"]))
}

func TestReminderAgentSwitchHoldsAnOpenOneBackUntilItIsOnAgain(t *testing.T) {
	rr := newRemRig(t)
	ctx := context.Background()
	_, once := rr.once("person", "Dev", "Look", time.Hour)
	check, _ := rr.ch.sched.ChiefCheck(ctx, id64(once))
	job, _ := rr.ch.sched.GetScheduledJob(ctx, check.JobID)
	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 1))
	require.Len(t, rr.messages(), 1)
	path := "/api/reminders/agents/" + sendSid(1) + "/switch"
	rr.call("POST", path, "person", map[string]any{"board": "team-a", "on": false})
	_, err := rr.h.db.ExecContext(ctx, `UPDATE chief_triggers SET created_at=? WHERE check_id=?`, time.Now().Add(-16*time.Minute).Unix(), id64(once))
	require.NoError(t, err)
	rr.ch.now = time.Now
	rr.ch.Poll(ctx)
	assert.Len(t, rr.messages(), 1, "no nudge while it is off")
	rr.call("POST", path, "person", map[string]any{"board": "team-a", "on": true})
	rr.ch.Poll(ctx)
	assert.Len(t, rr.messages(), 2, "the still-open reminder is told again once it is on")
}
