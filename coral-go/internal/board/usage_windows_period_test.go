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

// #19197: a week's usage read must not read every task the computer ever had. 3000 old tasks
// (one round each, long over) and three that touch the period: only those three come back, and
// the one that was claimed later but has an earlier round inside the period still does.
func TestUsageWindowsAreBoundedByThePeriod(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	stamp := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339) }
	insert := func(i int, claimed, completed, status, windows string) {
		task, err := s.CreateTask(ctx, "team", fmt.Sprintf("task %d", i), "", "medium", "Operator")
		require.NoError(t, err)
		_, err = s.Writer().ExecContext(ctx, `UPDATE board_tasks SET session_id='s', status=?, claimed_at=?, completed_at=?, work_windows=? WHERE id=?`, status, claimed, completed, windows, task.ID)
		require.NoError(t, err)
	}
	for i := 0; i < 3000; i++ {
		old := -time.Duration(400+i) * time.Hour
		insert(i, stamp(old), stamp(old+time.Hour), "completed", "")
	}
	insert(3001, stamp(-2*time.Hour), stamp(-time.Hour), "completed", "")                                                                // inside
	insert(3002, stamp(-3*time.Hour), "", "in_progress", "")                                                                             // still going
	insert(3003, stamp(-3000*time.Hour), stamp(-2990*time.Hour), "completed", `[["`+stamp(-5*time.Hour)+`","`+stamp(-4*time.Hour)+`"]]`) // an earlier round inside
	insert(3004, stamp(48*time.Hour), "", "in_progress", "")                                                                             // claimed after the period

	got, err := s.UsageWindows(ctx, now.Add(-24*time.Hour), now)
	require.NoError(t, err)
	ids := map[int64]bool{}
	for _, w := range got {
		ids[w.TaskID] = true
	}
	assert.Len(t, ids, 3, "the 3000 old tasks and the one claimed after the period are not read: %v", got)
	assert.Len(t, got, 3)

	all, err := s.UsageWindows(ctx, time.Time{}, time.Time{})
	require.NoError(t, err)
	assert.Greater(t, len(all), 3000, "no bounds still reads everything")
}
