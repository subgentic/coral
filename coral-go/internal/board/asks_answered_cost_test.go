package board

import (
	"context"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// #19923: AnsweredAsksOf reads a constant number of queries and at most the cap of rows, however many questions the board holds.
func TestAnsweredAsksOfCostIsIndependentOfTheNumberOfQuestions(t *testing.T) {
	ctx := context.Background()
	run := func(n, limit int) (queries int64, got []AnsweredAsk) {
		path := filepath.Join(t.TempDir(), "board.db")
		s, err := NewStoreWithKey(path, "")
		require.NoError(t, err)
		defer s.Close()
		for _, who := range []string{"Dev", "Operator"} {
			_, err := s.Subscribe(ctx, "team", who, "", "", nil, "all")
			require.NoError(t, err)
		}
		var qs []*Message
		for i := 0; i < n; i++ { // every question first: the asker posting again would be the agent acting
			q, err := s.PostMessage(ctx, "team", "Dev", "@Operator question "+strconv.Itoa(i), nil)
			require.NoError(t, err)
			to, err := s.AskTargets(ctx, "team", "Dev", q.Content)
			require.NoError(t, err)
			require.NoError(t, s.RecordAsk(ctx, "team", q, to))
			qs = append(qs, q)
		}
		for i, q := range qs {
			a, err := s.PostMessage(ctx, "team", "Operator", "answer "+strconv.Itoa(i), nil)
			require.NoError(t, err)
			require.NoError(t, s.RecordReply(ctx, "team", a.ID, q.ID))
		}
		count := countQueries(t, s, path)
		origRead := s.readDB
		s.readDB = nil                         // reads go through the counted connection
		defer func() { s.readDB = origRead }() // so Close closes the pool it opened
		before := count.Load()
		got, err = s.AnsweredAsksOf(ctx, "team", OperatorName, time.Now(), limit)
		require.NoError(t, err)
		return count.Load() - before, got
	}
	small, gotSmall := run(10, 100)
	large, gotLarge := run(300, 100)
	t.Logf("AnsweredAsksOf queries: %d for 10 questions, %d for 300", small, large)
	require.Len(t, gotSmall, 10)
	require.Len(t, gotLarge, 100, "the cap is applied in the query")
	require.Equal(t, "question 0", trimAt(gotLarge[0].Question), "oldest first")
	require.Equal(t, small, large, "the number of queries does not grow with the questions")
	require.LessOrEqual(t, large, int64(3))
}

func trimAt(s string) string { return s[len("@Operator "):] }
