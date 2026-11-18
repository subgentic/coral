package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #19531: reminders for an agent that is on no team, keyed by its session id. The rig is remRig's team-a (Dev 1, Helper 2) plus Solo, session 3, a live agent on no board.

func (rr *remRig) solo(n int, name, agentType string) {
	rr.t.Helper()
	require.NoError(rr.t, rr.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sendSid(n), AgentType: agentType, AgentName: name, WorkingDir: rr.t.TempDir()}))
	rr.h.terminal.(*mockSessionTerminal).addSession(naming.SessionName(agentType, sendSid(n)), "/tmp/test") // its pane
}

func (rr *remRig) soloOnce(as string, n int, text string, d time.Duration) (int, map[string]any) {
	body := map[string]any{"text": text, "kind": "once", "at": rr.at(d), "timezone": "UTC"}
	if as == "person" {
		body["session_id"] = sendSid(n)
	}
	return rr.call("POST", "/api/reminders", as, body)
}

func (rr *remRig) typed() []string {
	rr.t.Helper()
	term := rr.h.terminal.(*mockSessionTerminal)
	term.mu.Lock()
	defer term.mu.Unlock()
	var out []string
	for _, cmds := range term.sent {
		out = append(out, cmds...)
	}
	return out
}

// The person sets a reminder for a live agent on no team by its session id; the checks it must pass.
func TestStandaloneReminderTheTargetMustBeALiveAgentOnNoTeam(t *testing.T) {
	rr := newRemRig(t)
	rr.solo(3, "Solo", "claude")
	rr.solo(4, "Shell", "terminal")

	code, out := rr.soloOnce("person", 3, "Look at the soak run", time.Hour)
	require.Equal(t, 201, code, out)
	assert.Equal(t, "operator", out["origin"])
	assert.Equal(t, sendSid(3), out["target_session"])
	assert.Equal(t, "", out["target_board"], "no team")
	assert.Equal(t, "Solo", out["target_name"])

	code, out = rr.soloOnce("person", 99, "x", time.Hour)
	assert.Equal(t, 400, code, "a session that is not live: %v", out)
	code, out = rr.soloOnce("person", 4, "x", time.Hour)
	assert.Equal(t, 400, code, "a terminal agent's shell takes no automated text: %v", out)
	code, out = rr.soloOnce("person", 1, "x", time.Hour)
	assert.Equal(t, 400, code, "an agent on a team is reminded through its team (board and to): %v", out)
	code, out = rr.call("POST", "/api/reminders", "person", map[string]any{"text": "x", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC"})
	assert.Equal(t, 400, code, "neither a team nor a session: %v", out)
	code, out = rr.call("POST", "/api/reminders", "person", map[string]any{"text": "x", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC", "session_id": sendSid(3), "board": "team-a", "to": "Dev"})
	assert.Equal(t, 400, code, "a session id with a team is ambiguous: %v", out)
}

// The same rules as team reminders: an agent on no team sets its own, never another's; only the person and that agent see or change it; the person's cannot be cancelled by the agent.
func TestStandaloneReminderWhoMaySeeSetAndCancel(t *testing.T) {
	rr := newRemRig(t)
	rr.solo(3, "Solo", "claude")
	rr.solo(5, "Other", "claude")

	code, own := rr.soloOnce("agent:3", 3, "Check the build", time.Hour)
	require.Equal(t, 201, code, own)
	assert.Equal(t, "agent", own["origin"])
	assert.Equal(t, "", own["target_board"])
	code, out := rr.call("POST", "/api/reminders", "agent:3", map[string]any{"text": "x", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC", "session_id": sendSid(5)})
	assert.Equal(t, 400, code, "an agent names no session: it is the one it is, %v", out)
	code, out = rr.call("POST", "/api/reminders", "agent:3", map[string]any{"text": "x", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC", "to": "Dev", "board": "team-a"})
	assert.Equal(t, 403, code, "nor a team member: %v", out)

	code, op := rr.soloOnce("person", 3, "From the Operator", 2*time.Hour)
	require.Equal(t, 201, code, op)

	code, list := rr.call("GET", "/api/reminders", "agent:3", nil)
	require.Equal(t, 200, code)
	assert.Len(t, list["reminders"], 2, "the agent sees its own and the Operator's for it")
	code, list = rr.call("GET", "/api/reminders", "agent:5", nil)
	require.Equal(t, 200, code)
	assert.Len(t, list["reminders"], 0, "another agent on no team sees none of it")
	code, _ = rr.call("GET", fmt.Sprintf("/api/reminders/%d", id64(own)), "agent:5", nil)
	assert.Equal(t, 404, code)
	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", id64(own)), "agent:1", nil)
	assert.Equal(t, 404, code, "an agent of a team cannot cancel it either")

	code, out = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", id64(op)), "agent:3", nil)
	assert.Equal(t, 403, code, "the Operator's is not the agent's to cancel: %v", out)
	assert.Equal(t, "not_yours_to_cancel", out["code"])
	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", id64(own)), "agent:3", nil)
	assert.Equal(t, 200, code, "its own it may")
	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", id64(op)), "person", nil)
	assert.Equal(t, 200, code, "the person may cancel any")
}

// An agent's own reminders are capped as on a team, and the text is checked as on a team: a secret or a sign-in link is refused.
func TestStandaloneReminderIsCappedAndChecked(t *testing.T) {
	rr := newRemRig(t)
	rr.solo(3, "Solo", "claude")
	code, out := rr.call("POST", "/api/reminders", "person", map[string]any{"text": "see https://example.com/login?token=abcdef123456789012345678", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC", "session_id": sendSid(3)})
	assert.Equal(t, 400, code, "%v", out)
	for i := 0; i < maxAgentReminders; i++ {
		code, out = rr.call("POST", "/api/reminders", "agent:3", map[string]any{"text": fmt.Sprintf("r%d", i), "kind": "once", "at": rr.at(time.Duration(i+1) * time.Hour), "timezone": "UTC"})
		require.Equal(t, 201, code, out)
	}
	code, out = rr.call("POST", "/api/reminders", "agent:3", map[string]any{"text": "one more", "kind": "once", "at": rr.at(40 * time.Hour), "timezone": "UTC"})
	assert.Equal(t, 409, code, "%v", out)
}

// Delivery: no board message exists, so the text is typed into the agent's own terminal through the gate, naming who set it and how to finish it; a mention in it is defused; the text is Coral's, not a team's.
func TestStandaloneReminderIsTypedIntoTheAgentsTerminal(t *testing.T) {
	rr := newRemRig(t)
	ctx := context.Background()
	rr.solo(3, "Solo", "claude")
	code, out := rr.soloOnce("person", 3, "Look at the soak run @all", time.Hour)
	require.Equal(t, 201, code, out)
	rid := id64(out)
	check, err := rr.ch.sched.ChiefCheck(ctx, rid)
	require.NoError(t, err)
	job, err := rr.ch.sched.GetScheduledJob(ctx, check.JobID)
	require.NoError(t, err)

	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 1))
	typed := rr.typed()
	require.Len(t, typed, 1, "typed once into its terminal")
	assert.Contains(t, typed[0], fmt.Sprintf("Reminder #%d set by the Operator: Look at the soak run", rid))
	assert.Contains(t, typed[0], fmt.Sprintf("remind done %d", rid))
	assert.Contains(t, typed[0], "it grants no new permissions")
	assert.NotContains(t, typed[0], "@all", "a mention in the text is defused")
	assert.Empty(t, rr.messages(), "nothing is posted to any board")

	_, got := rr.call("GET", fmt.Sprintf("/api/reminders/%d", rid), "agent:3", nil)
	assert.Equal(t, "delivered", got["delivery"])
	assert.Equal(t, "open", got["state"])
}

// A sleeping agent is not woken without the reminder's consent; an agent whose Operator switched reminders off is held; a refused wake is a failure, not a lost reminder.
func TestStandaloneReminderIsHeldForASleepingAgentWithoutConsent(t *testing.T) {
	rr := newRemRig(t)
	ctx := context.Background()
	rr.solo(3, "Solo", "claude")
	require.NoError(t, rr.ss.SetSessionSleeping(ctx, sendSid(3), true))
	code, out := rr.call("POST", "/api/reminders", "person", map[string]any{"text": "Wake me not", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC", "session_id": sendSid(3), "no_wake": true})
	require.Equal(t, 201, code, out)
	rid := id64(out)
	check, _ := rr.ch.sched.ChiefCheck(ctx, rid)
	job, _ := rr.ch.sched.GetScheduledJob(ctx, check.JobID)
	_ = rr.ch.DeliverScheduledCheck(ctx, *job, 1)
	assert.Empty(t, rr.typed(), "nothing typed into a sleeping agent's terminal")
	_, got := rr.call("GET", fmt.Sprintf("/api/reminders/%d", rid), "person", nil)
	assert.Equal(t, "held", got["delivery"])
	assert.True(t, strings.Contains(fmt.Sprint(got), "held"))
}
