package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Exercise the handler without the outer identity/sign-in middleware: these
// checks are intentional defence in depth, in addition to the router's guards.
func chiefHandlerCall(t *testing.T, h *ChiefChecksHandler, method, path string, body any, key string, person bool, via string) (int, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	if person {
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)
	if via != "" {
		req.Header.Set(tunnel.ViaHeader, via)
	}
	router := chi.NewRouter()
	h.Register(router)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return rec.Code, out
}
func chiefMessages(t *testing.T, rig *cmtRig) int {
	t.Helper()
	rows, err := rig.h.bs.ListMessages(context.Background(), "team-a", 100, 0, 0)
	require.NoError(t, err)
	return len(rows)
}

func TestChiefRetryAfterBoardPostAndFailedFinishAcknowledgesOriginalMessage(t *testing.T) {
	rig, h, c := chiefTestCheck(t, false)
	ctx := context.Background()
	now := time.Now()
	h.now = func() time.Time { return now }
	_, err := rig.h.db.ExecContext(ctx, `CREATE TRIGGER lose_chief_finish BEFORE UPDATE OF delivery ON chief_triggers WHEN NEW.delivery='delivered' BEGIN SELECT RAISE(ABORT,'lost finish'); END`)
	require.NoError(t, err)
	job, err := h.sched.GetScheduledJob(ctx, c.JobID)
	require.NoError(t, err)
	require.Error(t, h.DeliverScheduledCheck(ctx, *job, 1))
	require.Equal(t, 1, chiefMessages(t, rig))
	rows, err := h.sched.ChiefTriggers(ctx, c.ID, 0, "")
	require.NoError(t, err)
	require.Equal(t, "pending", rows[0].Delivery)
	require.Greater(t, rows[0].LeaseUntil, now.Unix())
	msgs, err := rig.h.bs.ListMessages(ctx, "team-a", 100, 0, 0)
	require.NoError(t, err)
	original := msgs[0].ID
	_, err = rig.h.db.ExecContext(ctx, `DROP TRIGGER lose_chief_finish`)
	require.NoError(t, err)
	restarted := NewChiefChecksHandler(rig.h.db, rig.h)
	restarted.now = func() time.Time { return now.Add(61 * time.Second) }
	restarted.Poll(ctx)
	got, err := h.sched.ChiefTrigger(ctx, rows[0].ID)
	require.NoError(t, err)
	require.Equal(t, "delivered", got.Delivery, "dedupe must acknowledge the existing message, not fail its unique key")
	require.Equal(t, original, got.MessageID)
	require.Equal(t, 1, chiefMessages(t, rig))
}
func TestChiefReminderPostsAtFifteenMinutesAndOnlyOnce(t *testing.T) {
	rig, h, c := chiefTestCheck(t, false)
	ctx := context.Background()
	now := time.Now().Truncate(time.Second)
	h.now = func() time.Time { return now }
	job, err := h.sched.GetScheduledJob(ctx, c.JobID)
	require.NoError(t, err)
	require.NoError(t, h.DeliverScheduledCheck(ctx, *job, 1))
	now = now.Add(15*time.Minute - time.Second)
	h.Poll(ctx)
	require.Equal(t, 1, chiefMessages(t, rig))
	now = now.Add(time.Second)
	h.Poll(ctx)
	require.Equal(t, 2, chiefMessages(t, rig))
	now = now.Add(time.Hour)
	h.Poll(ctx)
	require.Equal(t, 2, chiefMessages(t, rig))
	rows, err := h.sched.ChiefTriggers(ctx, c.ID, 0, "")
	require.NoError(t, err)
	require.Equal(t, "delivered", rows[0].Reminder)
}
func TestChiefDeliveryHoldsAndRejectsInvalidRecipient(t *testing.T) {
	for _, kind := range []string{"paused", "receive none", "all", "mention", "newline"} {
		t.Run(kind, func(t *testing.T) {
			rig, h, c := chiefTestCheck(t, false)
			ctx := context.Background()
			want, code := "held", "board_paused"
			switch kind {
			case "paused":
				rig.h.boardHandler = &BoardHandler{paused: map[string]bool{"team-a": true}}
			case "receive none":
				_, err := rig.h.bs.Subscribe(ctx, "team-a", "Dev", "Dev", "claude-"+sendSid(1), nil, "none")
				require.NoError(t, err)
				code = "target_receives_no_messages"
			default:
				title := map[string]string{"all": "all", "mention": "@Other", "newline": "Dev\nOther"}[kind]
				_, err := rig.h.bs.Writer().ExecContext(ctx, `UPDATE board_subscribers SET job_title=? WHERE project='team-a' AND subscriber_id='Dev'`, title)
				require.NoError(t, err)
				want, code = "failed", "invalid_recipient"
			}
			job, err := h.sched.GetScheduledJob(ctx, c.JobID)
			require.NoError(t, err)
			require.Error(t, h.DeliverScheduledCheck(ctx, *job, 1))
			rows, err := h.sched.ChiefTriggers(ctx, c.ID, 0, "")
			require.NoError(t, err)
			require.Equal(t, want, rows[0].Delivery)
			require.Equal(t, code, rows[0].DeliveryError)
			require.Zero(t, chiefMessages(t, rig))
		})
	}
}
func TestChiefDeliveryRechecksPersistedInstruction(t *testing.T) {
	for _, kind := range []string{"secret", "sign-in"} {
		t.Run(kind, func(t *testing.T) {
			rig, h, c := chiefTestCheck(t, false)
			ctx := context.Background()
			text, code := "Use password=yellow-test-value", "instruction_secret_refused"
			if kind == "sign-in" {
				text = "See http://localhost:8420/?login_token=" + secretToken
				code = "sign_in_link_refused"
			}
			// Simulate imported/old data that did not pass today's save checks.
			_, err := rig.h.db.ExecContext(ctx, `UPDATE chief_checks SET instruction=? WHERE id=?`, text, c.ID)
			require.NoError(t, err)
			job, err := h.sched.GetScheduledJob(ctx, c.JobID)
			require.NoError(t, err)
			require.Error(t, h.DeliverScheduledCheck(ctx, *job, 1))
			rows, err := h.sched.ChiefTriggers(ctx, c.ID, 0, "")
			require.NoError(t, err)
			require.Equal(t, "failed", rows[0].Delivery)
			require.Equal(t, code, rows[0].DeliveryError)
			require.Zero(t, chiefMessages(t, rig))
		})
	}
}
func TestChiefCurrentCheckCanRevokeSnapshotWakeConsent(t *testing.T) {
	rig, h, c := chiefTestCheck(t, true)
	ctx := context.Background()
	// If the consent guard is broken, a hard live cap stops the mutant before
	// any real wake can be attempted.
	rig.agent(2, "Awake", false)
	grant, err := rig.h.bs.GetOrchGrant(ctx, "team-a")
	require.NoError(t, err)
	grant.MaxLive = 1
	require.NoError(t, rig.h.bs.SetOrchGrant(ctx, grant, "Operator"))
	c.WakeIfAsleep = true
	c, err = h.sched.SaveChiefCheck(ctx, *c)
	require.NoError(t, err)
	tr, err := h.sched.BeginChiefTrigger(ctx, c.ID, 1, "consented-slot", time.Now())
	require.NoError(t, err)
	require.True(t, tr.WakeIfAsleep)
	c.WakeIfAsleep = false
	_, err = h.sched.SaveChiefCheck(ctx, *c)
	require.NoError(t, err)
	require.Error(t, h.deliverTrigger(ctx, tr.ID, "delivery"))
	got, err := h.sched.ChiefTrigger(ctx, tr.ID)
	require.NoError(t, err)
	require.Equal(t, "held", got.Delivery)
	require.Equal(t, "wake_consent_required", got.DeliveryError)
	require.Zero(t, chiefMessages(t, rig))
	var wakes int
	require.NoError(t, rig.h.bs.Reader().GetContext(ctx, &wakes, `SELECT COUNT(*) FROM board_lifecycle_log WHERE project='team-a'`))
	require.Zero(t, wakes, "revoked consent must not even reserve a wake")
}
func TestChiefHandlerRefusesSignInAtSaveWithoutOuterMiddleware(t *testing.T) {
	rig, h, c := chiefTestCheck(t, false)
	c.ID = 0
	c.JobID = 0
	c.Instruction = "See http://localhost:8420/?login_token=" + secretToken
	code, out := chiefHandlerCall(t, h, "POST", "/api/chief/checks", c, "", true, "")
	require.Equal(t, 400, code, out)
	require.Equal(t, "sign_in_link", out["code"])
	rows, err := h.sched.ChiefChecks(context.Background())
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Zero(t, chiefMessages(t, rig))
}
func TestChiefRunRequiresIdempotencyKeyBeforeCreatingWork(t *testing.T) {
	rig, h, c := chiefTestCheck(t, false)
	sched := background.NewJobScheduler(h.sched, time.Minute)
	h.SetScheduler(sched)
	t.Cleanup(func() { require.True(t, sched.WaitWatchers(time.Second)) })
	for _, key := range []string{"", "short", strings.Repeat("x", 129)} {
		code, out := chiefHandlerCall(t, h, "POST", fmt.Sprintf("/api/chief/checks/%d/run", c.ID), nil, key, true, "")
		require.Equal(t, 400, code, out)
	}
	rows, err := h.sched.ChiefTriggers(context.Background(), c.ID, 0, "")
	require.NoError(t, err)
	require.Empty(t, rows)
	require.Zero(t, chiefMessages(t, rig))
}
func TestChiefHandlerLocalPersonGuardsAreDefenceInDepth(t *testing.T) {
	_, h, _ := chiefTestCheck(t, false)
	code, out := chiefHandlerCall(t, h, http.MethodGet, "/api/chief/checks", nil, "", false, "")
	require.Equal(t, 403, code, out)
	code, out = chiefHandlerCall(t, h, http.MethodGet, "/api/chief/checks", nil, "", true, "hub")
	require.Equal(t, 404, code, out)
	code, out = chiefHandlerCall(t, h, http.MethodGet, "/api/chief/checks", nil, "", true, "")
	require.Equal(t, 200, code, out)
}
