package board

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func historyStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	return s
}

// The history a member's tasks make: claimed-to-completed times per agent, newest first, at most 30 each.
func TestClaimToDoneDurationsAreEachAgentsLatest(t *testing.T) {
	ctx := context.Background()
	s := historyStore(t)
	base := time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC)
	for i := 0; i < 35; i++ {
		task, err := s.CreateTask(ctx, "team", fmt.Sprintf("t%d", i), "", "medium", "lead", "Dev")
		require.NoError(t, err)
		claimed := base.Add(time.Duration(i) * time.Hour)
		done := claimed.Add(time.Duration(i+1) * time.Minute)
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status='completed', claimed_at=?, completed_at=?, completed_by='Dev' WHERE id=?`, claimed.Format(time.RFC3339), done.Format(time.RFC3339), task.ID)
		require.NoError(t, err)
	}
	other, err := s.CreateTask(ctx, "team", "other", "", "medium", "lead", "QA")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status='completed', claimed_at=?, completed_at=?, completed_by='QA' WHERE id=?`, base.Format(time.RFC3339), base.Add(7*time.Minute).Format(time.RFC3339), other.ID)
	require.NoError(t, err)
	got, err := s.ClaimToDoneDurations(ctx, "team")
	require.NoError(t, err)
	require.Len(t, got["Dev"], 30, "the latest 30")
	assert.Equal(t, 35*time.Minute, got["Dev"][0], "newest first: the 35th task took 35 minutes")
	assert.Equal(t, 6*time.Minute, got["Dev"][29])
	assert.Equal(t, []time.Duration{7 * time.Minute}, got["QA"])
	none, err := s.ClaimToDoneDurations(ctx, "elsewhere")
	require.NoError(t, err)
	assert.Empty(t, none, "scoped to the board")
}

// What a member said on a task: its posts that name #N, not #N as the start of a longer number.
func TestTaskPostTimesAreThePostsThatNameTheTask(t *testing.T) {
	ctx := context.Background()
	s := historyStore(t)
	_, err := s.Subscribe(ctx, "team", "Dev", "Developer", "dev-session", nil, "all")
	require.NoError(t, err)
	for _, text := range []string{"starting #12", "unrelated", "#123 is another task", "done with #12.", "see #12, #13"} {
		_, err := s.PostMessage(ctx, "team", "Dev", text, nil)
		require.NoError(t, err)
	}
	got, err := s.TaskPostTimes(ctx, "team", "Dev", 12, time.Now().Add(-time.Hour))
	require.NoError(t, err)
	assert.Len(t, got, 3, "'#12', 'with #12.' and 'see #12,': not '#123'")
	none, err := s.TaskPostTimes(ctx, "team", "Dev", 12, time.Now().Add(time.Hour))
	require.NoError(t, err)
	assert.Empty(t, none, "since the wait or claim")
}

// How long a pair's earlier waits took to be answered: only the resolved ones.
func TestResolvedWaitDurationsCountOnlyAnsweredWaits(t *testing.T) {
	ctx := context.Background()
	s := historyStore(t)
	at := time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC)
	add := func(status string, took time.Duration, target string) {
		_, err := s.db.ExecContext(ctx, `INSERT INTO board_waits(project, subscriber_id, session_name, wait_type, target_id, reason, status, created_at, resolved_at, expires_at) VALUES ('team','Dev','s','message',?, '', ?, ?, ?, ?)`,
			target, status, at.Format(time.RFC3339), at.Add(took).Format(time.RFC3339), at.Add(time.Hour).Format(time.RFC3339))
		require.NoError(t, err)
	}
	add("resolved", 5*time.Minute, "Security")
	add("resolved", 9*time.Minute, "Security")
	add("expired", 3*time.Hour, "Security")
	add("cancelled", 40*time.Minute, "Security")
	add("resolved", 2*time.Minute, "QA")
	got, err := s.ResolvedWaitDurations(ctx, "team", "Dev", "message", "Security", 30)
	require.NoError(t, err)
	assert.Equal(t, []time.Duration{9 * time.Minute, 5 * time.Minute}, got, "newest first, only resolved, only this target")
}
