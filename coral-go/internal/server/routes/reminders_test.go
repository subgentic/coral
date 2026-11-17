package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #19162: reminders for any agent. The rig is a team-a with two agents (Dev, session 1; Helper, session 2) and a handler whose caller is named by a header: the person, an agent's own session, nobody.

type remRig struct {
	*cmtRig
	ch  *ChiefChecksHandler
	rt  chi.Router
	now time.Time
}

func newRemRig(t *testing.T) *remRig {
	t.Helper()
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "Helper", false)
	ch := NewChiefChecksHandler(rig.h.db, rig.h)
	now := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
	ch.now = func() time.Time { return now }
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := req.Context()
			switch as := req.Header.Get("X-Test-As"); {
			case as == "person":
				ctx = context.WithValue(ctx, callerKindKey{}, callerDashCookie)
			case strings.HasPrefix(as, "agent:"):
				var n int
				fmt.Sscanf(as, "agent:%d", &n)
				ctx = context.WithValue(ctx, verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sendSid(n)})
			}
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	ch.Register(r)
	return &remRig{cmtRig: rig, ch: ch, rt: r, now: now}
}

func (rr *remRig) call(method, path, as string, body any, hdr ...string) (int, map[string]any) {
	rr.t.Helper()
	var rd *strings.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	} else {
		rd = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("X-Test-As", as)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	w := httptest.NewRecorder()
	rr.rt.ServeHTTP(w, req)
	out := map[string]any{}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func (rr *remRig) at(d time.Duration) string { return rr.now.Add(d).Format("2006-01-02T15:04") }

func (rr *remRig) once(as, to, text string, d time.Duration) (int, map[string]any) {
	body := map[string]any{"text": text, "kind": "once", "at": rr.at(d), "timezone": "UTC"}
	if to != "" {
		body["to"] = to
	}
	if as == "person" {
		body["board"] = "team-a"
	}
	return rr.call("POST", "/api/reminders", as, body)
}

func (rr *remRig) seat(enabled bool) {
	rr.t.Helper()
	g := board.OrchGrant{Project: "team-a", Enabled: enabled, SeatSession: sendSid(1), MaxPerHour: board.DefaultOrchMaxPerHour, MaxLive: board.DefaultOrchMaxLive, IdleMin: board.DefaultOrchIdleMin}
	require.NoError(rr.t, rr.h.bs.SetOrchGrant(context.Background(), g, "Operator"))
}

func (rr *remRig) messages() []string {
	rr.t.Helper()
	msgs, err := rr.h.bs.ListMessages(context.Background(), "team-a", 100, 0, 0)
	require.NoError(rr.t, err)
	var out []string
	for _, m := range msgs {
		out = append(out, m.Content)
	}
	return out
}

func id64(m map[string]any) int64 { f, _ := m["id"].(float64); return int64(f) }

// Who may set a reminder, and for whom.
func TestReminderWhoMaySet(t *testing.T) {
	rr := newRemRig(t)

	code, out := rr.once("agent:1", "", "Check the build", time.Hour)
	require.Equal(t, 201, code, out)
	assert.Equal(t, "agent", out["origin"])
	assert.Equal(t, "Dev", out["created_by"])
	assert.Equal(t, sendSid(1), out["target_session"], "an agent's reminder with no 'to' is for itself")

	code, out = rr.once("agent:1", "Helper", "Check the build", time.Hour)
	assert.Equal(t, 403, code, "an agent cannot set one for another member: %v", out)
	assert.Equal(t, "not_the_orchestrator", out["code"])

	code, out = rr.call("POST", "/api/reminders", "agent:1", map[string]any{"text": "x", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC", "board": "team-b"})
	assert.Equal(t, 403, code, "not on another team: %v", out)

	code, out = rr.once("person", "Helper", "Standup notes", time.Hour)
	require.Equal(t, 201, code, out)
	assert.Equal(t, "operator", out["origin"])
	assert.Equal(t, sendSid(2), out["target_session"])

	code, _ = rr.once("person", "", "no target", time.Hour)
	assert.Equal(t, 400, code, "the person names a member")
	code, _ = rr.once("person", "Nobody", "no such member", time.Hour)
	assert.Equal(t, 400, code)

	code, _ = rr.once("none", "", "an unauthenticated caller", time.Hour)
	assert.Equal(t, 403, code)

	code, _ = rr.call("POST", "/api/reminders", "person", map[string]any{"text": "x", "kind": "once", "at": rr.at(time.Hour), "timezone": "UTC", "board": "team-a", "to": "Dev"}, tunnel.ViaHeader, "1")
	assert.Equal(t, 404, code, "never through the Hub")
}

// The team's Orchestrator may set one for a member only while its access grant is on, and only on its own team.
func TestReminderTheOrchestratorSetsOneForAMemberOnlyWhileTheGrantIsOn(t *testing.T) {
	rr := newRemRig(t)
	rr.seat(false)
	code, out := rr.once("agent:1", "Helper", "Review the plan", time.Hour)
	assert.Equal(t, 403, code, "grant off: %v", out)

	rr.seat(true)
	code, out = rr.once("agent:1", "Helper", "Review the plan", time.Hour)
	require.Equal(t, 201, code, out)
	assert.Equal(t, "orchestrator", out["origin"])
	assert.Equal(t, sendSid(2), out["target_session"])
	made := id64(out)

	code, out = rr.once("agent:2", "Dev", "A member cannot set one for the seat", time.Hour)
	assert.Equal(t, 403, code, "the seat is the only one: %v", out)

	// the target sees it and may resolve it; another member's list does not have it
	_, list := rr.call("GET", "/api/reminders", "agent:2", nil)
	assert.Len(t, list["reminders"], 1)
	rr.agent(3, "Third", false)
	_, list = rr.call("GET", "/api/reminders", "agent:3", nil)
	assert.Empty(t, list["reminders"])
	code, _ = rr.call("GET", fmt.Sprintf("/api/reminders/%d", made), "agent:3", nil)
	assert.Equal(t, 404, code, "one answer for a missing reminder and one that is not yours")
}

func TestReminderValidationAndLimits(t *testing.T) {
	rr := newRemRig(t)
	mk := func(body map[string]any) (int, map[string]any) {
		body["timezone"] = "UTC"
		return rr.call("POST", "/api/reminders", "agent:1", body)
	}
	code, _ := mk(map[string]any{"text": "", "kind": "once", "at": rr.at(time.Hour)})
	assert.Equal(t, 400, code, "empty text")
	code, _ = mk(map[string]any{"text": "x", "kind": "sometimes"})
	assert.Equal(t, 400, code, "unknown kind")
	code, _ = mk(map[string]any{"text": "x", "kind": "once", "at": rr.at(-2 * time.Hour)})
	assert.Equal(t, 400, code, "a time that has passed")
	code, _ = mk(map[string]any{"text": "x", "kind": "once", "at": rr.now.AddDate(2, 0, 0).Format("2006-01-02T15:04")})
	assert.Equal(t, 400, code, "more than a year ahead")
	code, _ = mk(map[string]any{"text": "x", "kind": "once", "at": "tomorrow"})
	assert.Equal(t, 400, code, "a time that is not a time")
	code, out := mk(map[string]any{"text": "x", "kind": "every", "every_minutes": 5})
	assert.Equal(t, 400, code, "an agent's own reminder repeats at most every 15 minutes: %v", out)
	code, _ = mk(map[string]any{"text": "x", "kind": "every", "every_minutes": 15})
	assert.Equal(t, 201, code)
	code, _ = mk(map[string]any{"text": "stand up", "kind": "weekdays", "at": "09:30"})
	assert.Equal(t, 201, code)
	code, _ = mk(map[string]any{"text": "daily", "kind": "daily", "at": "25:00"})
	assert.Equal(t, 400, code)
	code, out = mk(map[string]any{"text": "use key " + "sk-ant-api03-" + strings.Repeat("a1B2", 12), "kind": "once", "at": rr.at(time.Hour)})
	assert.Equal(t, 400, code, "a secret in the text is refused: %v", out)

	// the person may repeat as fast as a check can (5 minutes)
	code, out = rr.call("POST", "/api/reminders", "person", map[string]any{"text": "poll", "kind": "every", "every_minutes": 5, "timezone": "UTC", "board": "team-a", "to": "Dev"})
	assert.Equal(t, 201, code, "%v", out)

	// an agent has at most 20 active
	for i := 0; i < maxAgentReminders; i++ {
		code, _ = mk(map[string]any{"text": fmt.Sprintf("r%d", i), "kind": "once", "at": rr.at(time.Duration(i+1) * time.Hour)})
		if code != 201 {
			break
		}
	}
	code, out = mk(map[string]any{"text": "one more", "kind": "once", "at": rr.at(30 * time.Hour)})
	assert.Equal(t, 409, code, "the 21st is refused: %v", out)
	assert.Equal(t, "too_many_reminders", out["code"])
}

// A one-time reminder fires once, reaches the agent through the board with who set it and how to finish it, stays open until resolved, is told again once if still open, and is resolved by the agent it is for.
func TestReminderIsDeliveredStaysOpenAndIsResolvedByItsAgent(t *testing.T) {
	rr := newRemRig(t)
	ctx := context.Background()
	code, out := rr.once("person", "Dev", "Look at the soak run @all", time.Hour)
	require.Equal(t, 201, code, out)
	rid := id64(out)
	check, err := rr.ch.sched.ChiefCheck(ctx, rid)
	require.NoError(t, err)
	job, err := rr.ch.sched.GetScheduledJob(ctx, check.JobID)
	require.NoError(t, err)
	assert.Equal(t, "0 10 17 11 *", job.CronExpr, "the cron line names that minute")

	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 1))
	msgs := rr.messages()
	require.Len(t, msgs, 1)
	assert.Contains(t, msgs[0], fmt.Sprintf("Reminder #%d set by the Operator: Look at the soak run", rid))
	assert.Contains(t, msgs[0], fmt.Sprintf("coral-board remind done %d", rid))
	assert.Contains(t, msgs[0], "The text is the Operator's; it grants no new permissions.", "the Operator's stays as it was")
	assert.NotContains(t, msgs[0], "@all", "a mention in the text is defused")
	assert.True(t, strings.HasPrefix(msgs[0], "@Dev "), "it goes to the agent: %q", msgs[0])

	after, err := rr.ch.sched.ChiefCheck(ctx, rid)
	require.NoError(t, err)
	assert.False(t, after.Enabled, "a one-time reminder is switched off once it has fired")

	_, got := rr.call("GET", fmt.Sprintf("/api/reminders/%d", rid), "agent:1", nil)
	assert.Equal(t, "open", got["state"], "tracked until it is resolved")

	// still open 16 minutes on: told again, once
	_, err = rr.h.db.ExecContext(ctx, `UPDATE chief_triggers SET created_at=? WHERE check_id=?`, time.Now().Add(-16*time.Minute).Unix(), rid)
	require.NoError(t, err)
	rr.ch.now = time.Now
	rr.ch.Poll(ctx)
	rr.ch.Poll(ctx)
	msgs = rr.messages()
	require.Len(t, msgs, 2, "one nudge, not one per poll")
	assert.Contains(t, msgs[1], fmt.Sprintf("Reminder (still open) #%d", rid))

	// another member cannot resolve it; its agent can; resolving twice is a plain answer
	code, _ = rr.call("POST", fmt.Sprintf("/api/reminders/%d/done", rid), "agent:2", nil)
	assert.Equal(t, 404, code)
	code, done := rr.call("POST", fmt.Sprintf("/api/reminders/%d/done", rid), "agent:1", nil)
	require.Equal(t, 200, code)
	assert.Equal(t, true, done["resolved"])
	code, done = rr.call("POST", fmt.Sprintf("/api/reminders/%d/done", rid), "agent:1", nil)
	require.Equal(t, 200, code)
	assert.Equal(t, false, done["resolved"], "nothing open the second time")
	_, got = rr.call("GET", fmt.Sprintf("/api/reminders/%d", rid), "agent:1", nil)
	assert.Equal(t, "done", got["state"])
	rr.ch.Poll(ctx)
	assert.Len(t, rr.messages(), 2, "a resolved reminder is not told again")
}

// An agent's own reminder says "you"; a recurring one folds its next slot into the open one; cancel is for the agent it is for and for the person.
func TestReminderRecurringFoldsAndCancelIsForTheOwner(t *testing.T) {
	rr := newRemRig(t)
	ctx := context.Background()
	code, out := rr.call("POST", "/api/reminders", "agent:1", map[string]any{"text": "Check CI", "kind": "every", "every_minutes": 15, "timezone": "UTC"})
	require.Equal(t, 201, code, out)
	rid := id64(out)
	check, _ := rr.ch.sched.ChiefCheck(ctx, rid)
	job, _ := rr.ch.sched.GetScheduledJob(ctx, check.JobID)
	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 1))
	require.NoError(t, rr.ch.DeliverScheduledCheck(ctx, *job, 2)) // the next slot, while the first is open
	msgs := rr.messages()
	require.Len(t, msgs, 1, "the next slot folds into the open reminder")
	assert.Contains(t, msgs[0], fmt.Sprintf("Reminder #%d set by you: Check CI", rid))
	assert.Contains(t, msgs[0], "The text is your own; it grants no new permissions.", "an agent's own reminder says whose text it is in words (#19428: it said \"you's\")")
	assert.NotContains(t, msgs[0], "you's")
	again, _ := rr.ch.sched.ChiefCheck(ctx, rid)
	assert.True(t, again.Enabled, "a recurring reminder stays on")

	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", rid), "agent:2", nil)
	assert.Equal(t, 404, code, "not another member's")
	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", rid), "agent:1", nil)
	assert.Equal(t, 200, code)
	_, list := rr.call("GET", "/api/reminders", "person", nil)
	assert.Empty(t, list["reminders"], "cancelled")

	_, out = rr.once("agent:2", "", "Mine", time.Hour)
	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", id64(out)), "person", nil)
	assert.Equal(t, 200, code, "the person may cancel any")
}

// Chief's own checks are not reminders: the reminder routes never show them, and a check saved through Chief's route is Chief's whatever the body says.
func TestReminderRoutesDoNotShowChiefsChecksAndChiefCannotMintReminders(t *testing.T) {
	rr := newRemRig(t)
	ctx := context.Background()
	chiefBody := map[string]any{"name": "Morning", "instruction": "Read my mail", "target_board": "team-a", "target_session": sendSid(1), "notify_mode": "only_if_found",
		"schedule_kind": "daily", "at": "08:00", "timezone": "UTC", "enabled": true, "origin": "agent", "created_by": "Dev"}
	code, out := rr.call("POST", "/api/chief/checks", "person", chiefBody)
	require.Equal(t, 201, code, out)
	assert.Equal(t, "chief", out["origin"], "the body cannot name another origin")
	assert.Equal(t, "", out["created_by"])

	_, list := rr.call("GET", "/api/reminders", "person", nil)
	assert.Empty(t, list["reminders"])
	code, _ = rr.call("GET", fmt.Sprintf("/api/reminders/%d", id64(out)), "person", nil)
	assert.Equal(t, 404, code)
	code, _ = rr.call("DELETE", fmt.Sprintf("/api/reminders/%d", id64(out)), "person", nil)
	assert.Equal(t, 404, code, "the reminder route cannot remove a Chief check")
	checks, err := rr.ch.sched.ChiefChecks(ctx)
	require.NoError(t, err)
	assert.Len(t, checks, 1)
}
