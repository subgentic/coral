package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// #15461 (Security on #15340): completed_since reads both the bound and the stored time as instants. As text, "10:00:00.5Z" sorts before "10:00:00Z" ('.' is before 'Z'), so a fraction of a second at the boundary
// put a task on the wrong side.
func TestCompletedSinceComparesInstantsNotText(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for i, at := range []string{"2026-11-10T09:59:59Z", "2026-11-10T10:00:00Z", "2026-11-10T10:00:00.5Z", "2026-11-10T10:00:00.7Z", "2026-11-10T10:00:00.9Z", "2026-11-10T10:00:01Z", "2026-11-10T11:00:00.25Z"} {
		_, err := s.db.ExecContext(ctx, `INSERT INTO board_tasks(board_id, title, status, created_by, created_at, completed_at) VALUES ('t', ?, 'completed', 'x', '2026-11-10T00:00:00Z', ?)`, "task"+string(rune('a'+i)), at)
		require.NoError(t, err)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO board_tasks(board_id, title, status, created_by, created_at, completed_at) VALUES ('t', 'skipped', 'skipped', 'x', '2026-11-10T00:00:00Z', '2026-11-10T10:30:00Z')`)
	require.NoError(t, err)
	for _, c := range []struct {
		since string
		want  int
	}{
		{"2026-11-10T10:00:00Z", 6},           // 00Z itself and everything after, the .5 included
		{"2026-11-10T10:00:00.7Z", 4},         // .7 itself, .9, 01Z and the 11:00 one: not 00Z or .5
		{"2026-11-10T10:00:00.700000000Z", 4}, // the same instant written with nine digits
		{"2026-11-10T12:00:00+02:00", 6},      // the same instant as the first, with an offset
		{"2026-11-10T10:00:01Z", 2},
		{"2026-11-10T11:00:00.5Z", 0},
	} {
		page, err := s.TaskCounts(ctx, "t", c.since)
		require.NoError(t, err, c.since)
		require.NotNil(t, page.CompletedSince, c.since)
		require.Equal(t, c.want, *page.CompletedSince, "since %s (a skipped task is never counted)", c.since)
	}
}
