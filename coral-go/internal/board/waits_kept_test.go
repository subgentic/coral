package board

import (
	"context"
	"database/sql"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11930 (3): the migration that adds board_waits.question_kept_at marks the operator waits that had already expired as kept: a release does not replay old history into the Operator's Needs you. A wait that expires
// after the upgrade is not marked, so it is kept.
func TestTheMigrationMarksQuestionsThatExpiredBeforeItAsKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	require.NoError(t, s.Close())
	raw, err := sql.Open("sqlite", path)
	require.NoError(t, err)
	_, err = raw.Exec(`ALTER TABLE board_waits DROP COLUMN question_kept_at`) // the database of a release that did not have the column
	require.NoError(t, err)
	old := time.Now().UTC().Add(-48 * time.Hour).Format(time.RFC3339)
	_, err = raw.Exec(`INSERT INTO board_waits (project, subscriber_id, session_name, wait_type, target_id, reason, status, created_at, expires_at, resolved_at)
		VALUES ('team', 'Lead', 'claude-lead', 'operator', 'Operator', 'An old question the release before never kept', 'expired', ?, ?, ?)`, old, old, old)
	require.NoError(t, err)
	require.NoError(t, raw.Close())

	s, err = NewStoreWithKey(path, "") // the upgrade: the column is added and the expired rows marked
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	ctx := context.Background()
	got, err := s.ExpiredOperatorQuestions(ctx, "team")
	require.NoError(t, err)
	assert.Empty(t, got, "a question that expired before the upgrade is not replayed")

	_, err = s.RegisterWait(ctx, "team", "Dev", "claude-dev", WaitOperator, "Operator", "A question that expires after the upgrade", time.Second)
	require.NoError(t, err)
	time.Sleep(2200 * time.Millisecond) // sleep-ok: a real one-second timeout running out
	got, err = s.ExpiredOperatorQuestions(ctx, "team")
	require.NoError(t, err)
	require.Len(t, got, 1, "one that expires after the upgrade is to be kept")
	assert.Equal(t, "A question that expires after the upgrade", got[0].Reason)

	s2, err := NewStoreWithKey(path, "") // a second start does not mark it either
	require.NoError(t, err)
	t.Cleanup(func() { s2.Close() })
	got, err = s2.ExpiredOperatorQuestions(ctx, "team")
	require.NoError(t, err)
	assert.Len(t, got, 1, "starting again leaves it to be kept")
}

// #11930 (3): however many reads race for an expired question, one claims it: it is kept once.
func TestOneReadClaimsAnExpiredQuestionWhateverTheRace(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	w, err := s.RegisterWait(ctx, "team", "Lead", "claude-lead", WaitOperator, "Operator", "Decision 1: go?", time.Second)
	require.NoError(t, err)
	time.Sleep(2200 * time.Millisecond) // sleep-ok: a real one-second timeout running out
	got, err := s.ExpiredOperatorQuestions(ctx, "team")
	require.NoError(t, err)
	require.Len(t, got, 1)
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if won, err := s.ClaimExpiredQuestion(ctx, w.ID); err == nil && won {
				winners.Add(1)
			}
		}()
	}
	wg.Wait()
	assert.EqualValues(t, 1, winners.Load(), "exactly one of the racing reads keeps the question")
	left, _ := s.ExpiredOperatorQuestions(ctx, "team")
	assert.Empty(t, left, "and it is no longer to be kept")
	s.UnclaimExpiredQuestion(ctx, w.ID)
	left, _ = s.ExpiredOperatorQuestions(ctx, "team")
	assert.Len(t, left, 1, "giving the claim back makes it keepable again")
}
