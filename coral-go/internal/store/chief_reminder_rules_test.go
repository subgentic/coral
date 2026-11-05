package store

import (
	"context"
	"github.com/stretchr/testify/require"
	"testing"
	"time"
)

func TestChiefReminderWaitAndStateRulesApplyToScanAndClaim(t *testing.T) {
	for _, state := range []string{"open", "routed", "waiting_on_operator", "done"} {
		t.Run(state, func(t *testing.T) {
			s := NewScheduleStore(openTestDB(t))
			ctx := context.Background()
			now := time.Now().Truncate(time.Second)
			c, err := s.SaveChiefCheck(ctx, ChiefCheck{Name: "CI", Instruction: "Check CI", TargetBoard: "chief", TargetSession: "s", NotifyMode: "every_time", ScheduleKind: "interval", EveryMinutes: 15, Timezone: "UTC"})
			require.NoError(t, err)
			tr, err := s.BeginChiefTrigger(ctx, c.ID, 0, "", now)
			require.NoError(t, err)
			require.NoError(t, s.FinishChiefDelivery(ctx, tr.ID, "delivery", "delivered", "", 1, now))
			require.NoError(t, s.UpdateChiefTriggerState(ctx, tr.ID, state, "", 0, 0, 0, now))
			early := now.Add(15*time.Minute - time.Second)
			rows, err := s.ChiefPendingDelivery(ctx, early)
			require.NoError(t, err)
			require.Empty(t, rows)
			ok, err := s.ClaimChiefDelivery(ctx, tr.ID, "reminder", early)
			require.NoError(t, err)
			require.False(t, ok)
			due := now.Add(15 * time.Minute)
			rows, err = s.ChiefPendingDelivery(ctx, due)
			require.NoError(t, err)
			if state == "open" {
				require.Len(t, rows, 1)
			} else {
				require.Empty(t, rows)
			}
			ok, err = s.ClaimChiefDelivery(ctx, tr.ID, "reminder", due)
			require.NoError(t, err)
			require.Equal(t, state == "open", ok)
		})
	}
}
func TestChiefDoneTriggerNeverClaimsPendingDelivery(t *testing.T) {
	s := NewScheduleStore(openTestDB(t))
	ctx := context.Background()
	now := time.Now()
	c, err := s.SaveChiefCheck(ctx, ChiefCheck{Name: "CI", Instruction: "Check CI", TargetBoard: "chief", TargetSession: "s", NotifyMode: "every_time", ScheduleKind: "interval", EveryMinutes: 15, Timezone: "UTC"})
	require.NoError(t, err)
	tr, err := s.BeginChiefTrigger(ctx, c.ID, 0, "", now.Add(-time.Hour))
	require.NoError(t, err)
	require.NoError(t, s.UpdateChiefTriggerState(ctx, tr.ID, "done", "cancelled before delivery", 0, 0, 0, now))
	rows, err := s.ChiefPendingDelivery(ctx, now)
	require.NoError(t, err)
	require.Empty(t, rows)
	ok, err := s.ClaimChiefDelivery(ctx, tr.ID, "delivery", now)
	require.NoError(t, err)
	require.False(t, ok)
}
