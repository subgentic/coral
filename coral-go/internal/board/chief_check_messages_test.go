package board

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestChiefMessageKeyLengthRefusedBeforePosting(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, key := range []string{"", strings.Repeat("a", 31), strings.Repeat("a", 33)} {
		_, err := s.PostChiefCheckMessage(ctx, "chief", 1, key, "delivery", "@Chief scheduled check")
		require.Error(t, err)
	}
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_messages`))
	require.Zero(t, n)
	id, err := s.PostChiefCheckMessage(ctx, "chief", 1, strings.Repeat("b", 32), "delivery", "@Chief scheduled check")
	require.NoError(t, err)
	require.Positive(t, id)
}
func TestChiefMessageHistoryCapAllowsDedupeButRefusesNewMessages(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	key := strings.Repeat("b", 32)
	id, err := s.PostChiefCheckMessage(ctx, "chief", 1, key, "delivery", "@Chief scheduled check")
	require.NoError(t, err)
	// Seed retained dedupe metadata at the limit; no content bodies are needed.
	_, err = s.db.ExecContext(ctx, `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<19999) INSERT INTO chief_check_messages(trigger_id,trigger_key,kind,project,message_id,created_at) SELECT x+1,printf('%032x',x),'delivery','chief',?,? FROM n`, id, time.Now().Unix())
	require.NoError(t, err)
	again, err := s.PostChiefCheckMessage(ctx, "chief", 1, key, "delivery", "must not be posted")
	require.NoError(t, err)
	require.Equal(t, id, again)
	_, err = s.PostChiefCheckMessage(ctx, "chief", 20001, strings.Repeat("c", 32), "delivery", "at capacity")
	require.Error(t, err)
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_messages`))
	require.Equal(t, 1, n)
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM chief_check_messages`))
	require.Equal(t, 20000, n)
}
