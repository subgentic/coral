package board

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// BenchmarkPlainMessageSearch is a text search the index does not answer, on 50,000 messages of about 808 bytes (what v2.0.2's measurement used, #9744): the search with the index off, and one for a word the index
// cannot narrow (it is in most messages). go test ./internal/board -run xxx -bench PlainMessageSearch -benchtime 5x
func BenchmarkPlainMessageSearch(b *testing.B) {
	t := b.TempDir()
	s, err := NewStoreWithKey(filepath.Join(t, "board_plain_search.db"), "")
	require.NoError(b, err)
	b.Cleanup(func() { s.Close() })
	ctx := context.Background()
	words := strings.Fields("progress review task commit branch landing agent team message board goal release notes tests golden census batch frontend backend security hub tunnel patch gate green red")
	tx, err := s.db.BeginTxx(ctx, nil)
	require.NoError(b, err)
	for i := 0; i < 50000; i++ {
		var sb strings.Builder
		for sb.Len() < 790 {
			sb.WriteString(words[(i*7+sb.Len()*13)%len(words)])
			sb.WriteByte(' ')
		}
		if i%1000 == 7 {
			sb.WriteString("zuerichunique")
		}
		text := sb.String()
		if len(text) > 808 {
			text = text[:808]
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO board_messages(project, session_id, subscriber_id, content, created_at) VALUES ('proj','dev','dev',?,?)`, text, fmt.Sprintf("2026-10-27T%02d:%02d:00Z", (i/60)%24, i%60))
		require.NoError(b, err)
	}
	require.NoError(b, tx.Commit())
	query := func(needle string) *MessageQuery {
		q, err := ParseMessageQuery(MessageQueryParams{Q: []string{needle}})
		require.NoError(b, err)
		q.Project = "proj"
		return q
	}
	for _, needle := range []string{"zuerichunique", "census batch", "progress"} {
		b.Run(needle, func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_, err := s.QueryMessages(ctx, query(needle))
				require.NoError(b, err)
			}
		})
		// the scan of whole rows, as v2.0.1 answered every text search (an identity Shown keeps the id-and-text read out)
		b.Run(needle+"/whole-row-scan", func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				q := query(needle)
				q.Shown = func(s string) string { return s }
				_, err := s.QueryMessages(ctx, q)
				require.NoError(b, err)
			}
		})
	}
}
