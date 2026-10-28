package board

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9744: queryTextInSQL reads each message's text once (the bytes, whether any is odd, and whether it matches), not three times. Called directly, it must still decline exactly where it did (a board past the rows
// cap or the bytes cap, a NUL byte, a U+0130 or U+212A for a needle with an i or k) and answer exactly the ids LIKE matches, in the query's order, otherwise.
func TestQueryTextInSQLOnePassDeclinesAndAnswersAsBefore(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := sub(s, ctx, "proj", "dev", "Dev")
	require.NoError(t, err)
	var wantAsc []int64
	for i := 0; i < 40; i++ {
		text := fmt.Sprintf("message %d with some words", i)
		if i%3 == 0 {
			text = fmt.Sprintf("a PROGRESS note %d", i)
		}
		m, err := s.PostMessage(ctx, "proj", "dev", text, nil)
		require.NoError(t, err)
		if i%3 == 0 {
			wantAsc = append(wantAsc, m.ID)
		}
	}
	ask := func(needle, dir string) (*MessageQueryResult, bool) {
		q, err := ParseMessageQuery(MessageQueryParams{Q: []string{needle}, Limit: []string{"200"}})
		require.NoError(t, err)
		q.Project = "proj"
		res, ok, err := s.queryTextInSQL(ctx, q, []string{"m.project = ?"}, []any{"proj"}, dir)
		require.NoError(t, err)
		return res, ok
	}
	ids := func(r *MessageQueryResult) []int64 {
		var out []int64
		for _, m := range r.Messages {
			out = append(out, m.ID)
		}
		return out
	}

	res, ok := ask("progress", "ASC")
	require.True(t, ok)
	assert.Equal(t, wantAsc, ids(res), "the ids LIKE matches, oldest first")
	res, ok = ask("progress", "DESC")
	require.True(t, ok)
	var wantDesc []int64
	for i := len(wantAsc) - 1; i >= 0; i-- {
		wantDesc = append(wantDesc, wantAsc[i])
	}
	assert.Equal(t, wantDesc, ids(res), "newest first, whatever order the list was concatenated in")
	res, ok = ask("no such words anywhere", "ASC")
	require.True(t, ok)
	assert.Empty(t, res.Messages)

	// the rows cap: over it the Go scan answers
	oldRows := messageScanRows
	messageScanRows = 39
	_, ok = ask("progress", "ASC")
	assert.False(t, ok, "40 messages, a cap of 39")
	messageScanRows = 40
	_, ok = ask("progress", "ASC")
	assert.True(t, ok, "40 messages, a cap of 40")
	messageScanRows = oldRows

	// the bytes cap
	var total int64
	require.NoError(t, s.db.GetContext(ctx, &total, `SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM board_messages`))
	oldBytes := messageScanBytes
	messageScanBytes = int(total) - 1
	_, ok = ask("progress", "ASC")
	assert.False(t, ok, "the text is one byte over the cap")
	messageScanBytes = int(total)
	_, ok = ask("progress", "ASC")
	assert.True(t, ok, "and exactly at it")
	messageScanBytes = oldBytes

	// where LIKE and Go's match differ, Go answers
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET content = 'head' || char(0) || ' progress after the NUL' WHERE id = ?`, wantAsc[1])
	require.NoError(t, err)
	_, ok = ask("progress", "ASC")
	assert.False(t, ok, "a NUL byte in a message")
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET content = 'plain text' WHERE id = ?`, wantAsc[1])
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET content = 'a ' || char(8490) || ' sign here' WHERE id = ?`, wantAsc[2])
	require.NoError(t, err)
	_, ok = ask("progress", "ASC")
	assert.True(t, ok, "a needle with no i or k: U+212A is no difference to LIKE")
	_, ok = ask("with some", "ASC")
	assert.False(t, ok, "a needle with an i and a U+212A in a message")
}
