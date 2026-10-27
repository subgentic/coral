package board

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9249: a plain text search is answered by the database (LIKE) and gives what the Go scan gives: the same messages, order, total and
// cursors. The Go scan is forced here by an identity Shown, which the SQL path leaves to Go.

func queryBoth(t *testing.T, s *Store, p MessageQueryParams) (sqlRes, goRes *MessageQueryResult) {
	t.Helper()
	run := func(force bool) *MessageQueryResult {
		q, err := ParseMessageQuery(p)
		require.NoError(t, err)
		q.Project = "proj"
		if force {
			q.Shown = func(s string) string { return s }
		}
		res, err := s.QueryMessages(context.Background(), q)
		require.NoError(t, err)
		return res
	}
	return run(false), run(true)
}

func TestMessageQueryTextInSQLMatchesGoScan(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	sub(s, ctx, "proj", "dev", "Backend Dev")
	texts := []string{"Progress report", "no match here", "PROGRESS again", "100% done_ok", "back\\slash 100%", "a_b", "axb", "Pro-gress", "progress", "ünï progress", "100%", "x"}
	for i := 0; i < 60; i++ {
		_, err := s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("%s #%d", texts[i%len(texts)], i), nil)
		require.NoError(t, err)
	}
	for _, needle := range []string{"progress", "PROGRESS", "100%", "_", "a_b", "\\", "%", "x", "#1", "no match", "zzz", "report"} {
		for _, sort := range []string{"newest", "oldest"} {
			p := MessageQueryParams{Q: []string{needle}, Sort: []string{sort}, Limit: []string{"4"}}
			a, b := queryBoth(t, s, p)
			require.Equal(t, b, a, "%q %s first page", needle, sort)
			// walk forward, then back, comparing every page
			for pages, cur := 0, a.NextCursor; cur != "" && pages < 30; pages++ {
				p.Cursor = []string{cur}
				a, b = queryBoth(t, s, p)
				require.Equal(t, b, a, "%q %s forward", needle, sort)
				cur = a.NextCursor
				if a.PrevCursor != "" {
					pp := p
					pp.Cursor = []string{a.PrevCursor}
					pa, pb := queryBoth(t, s, pp)
					require.Equal(t, pb, pa, "%q %s back", needle, sort)
				}
			}
		}
	}
	a, _ := queryBoth(t, s, MessageQueryParams{Q: []string{"100%"}, Limit: []string{"200"}})
	for _, m := range a.Messages {
		assert.Contains(t, m.Content, "100%", "a % in the needle is not a wildcard")
	}
	a, _ = queryBoth(t, s, MessageQueryParams{Q: []string{"a_b"}, Limit: []string{"200"}})
	for _, m := range a.Messages {
		assert.Contains(t, m.Content, "a_b", "a _ in the needle is not a wildcard")
	}
}

func TestMessageQueryTextInSQLTimeBounds(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	sub(s, ctx, "proj", "dev", "Backend Dev")
	for i := 0; i < 20; i++ {
		m, err := s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("needle %d", i), nil)
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, "UPDATE board_messages SET created_at = ? WHERE id = ?", fmt.Sprintf("2026-10-%02dT10:00:00Z", 1+i), m.ID)
		require.NoError(t, err)
	}
	a, b := queryBoth(t, s, MessageQueryParams{Q: []string{"needle"}, Since: []string{"2026-10-05T00:00:00Z"}, Until: []string{"2026-10-12T00:00:00Z"}, Limit: []string{"50"}})
	require.Equal(t, b, a)
	assert.Equal(t, 7, a.Total)
}

// Go folds U+0130 and U+212A to i and k; LIKE does not, so a board holding either answers an i or k search by the Go scan.
func TestMessageQueryTextFoldedLettersUseGoScan(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	sub(s, ctx, "proj", "dev", "Backend Dev")
	for _, c := range []string{"plain kite", "İstanbul trip", "Kelvin", "nothing"} {
		_, err := s.PostMessage(ctx, "proj", "dev", c, nil)
		require.NoError(t, err)
	}
	for _, needle := range []string{"istanbul", "kelvin", "kite", "trip", "nothing"} {
		a, b := queryBoth(t, s, MessageQueryParams{Q: []string{needle}})
		require.Equal(t, b, a, needle)
		assert.Equal(t, 1, a.Total, needle)
	}
}

// 50,000 messages: the answer is the Go scan's and the time is logged. The assertion is a gross one (timing tests flake); the numbers are in the log.
func TestMessageQueryTextAt50k(t *testing.T) {
	if testing.Short() {
		t.Skip("50k messages")
	}
	s := testStore(t)
	ctx := context.Background()
	sub(s, ctx, "proj", "dev", "Backend Dev")
	tx, err := s.db.BeginTx(ctx, nil)
	require.NoError(t, err)
	for i := 0; i < 50000; i++ {
		body := fmt.Sprintf("message %d: %s", i, strings.Repeat("lorem ipsum dolor sit amet ", 8))
		if i%25 == 0 {
			body += " progress"
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO board_messages (project, subscriber_id, session_id, content, created_at) VALUES ('proj', 'dev', '', ?, ?)", body, time.Unix(1.8e9+int64(i), 0).UTC().Format(time.RFC3339))
		require.NoError(t, err)
	}
	require.NoError(t, tx.Commit())
	p := MessageQueryParams{Q: []string{"progress"}, Limit: []string{"20"}}
	start := time.Now()
	a, b := queryBoth(t, s, p)
	t.Logf("both paths, first call: %v", time.Since(start))
	require.Equal(t, b, a)
	assert.Equal(t, 2000, a.Total)
	var sqlBest, goBest time.Duration = 1 << 62, 1 << 62
	for i := 0; i < 5; i++ {
		for _, force := range []bool{false, true} {
			q, err := ParseMessageQuery(p)
			require.NoError(t, err)
			q.Project = "proj"
			if force {
				q.Shown = func(s string) string { return s }
			}
			t0 := time.Now()
			_, err = s.QueryMessages(ctx, q)
			require.NoError(t, err)
			d := time.Since(t0)
			if force {
				goBest = min(goBest, d)
			} else {
				sqlBest = min(sqlBest, d)
			}
		}
	}
	t.Logf("50k messages, 2000 matches: SQL path best %v, Go scan best %v", sqlBest, goBest)
	assert.Less(t, sqlBest, goBest, "the SQL path is the faster one")
}
