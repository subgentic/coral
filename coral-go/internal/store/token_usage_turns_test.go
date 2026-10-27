package store

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9482: GetUsageTurns reads the newest (or dearest) turns of each table and merges them; it used to read the view token_usage_all whole. The old query is spelled out here and run on the
// same database against the new: the new code is not compared with itself. A cross-table tie (a raw row and an hourly row with the same recorded_at AND id) is the one case the old order
// left unspecified; none can arise (a rolled-up hourly row keeps the id of the raw row it replaced, and ids are not reused), and the test asserts the data has none.

func oldGetUsageTurns(t *testing.T, s *TokenUsageStore, q UsageTurnsQuery) []UsageTurn {
	t.Helper()
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > MaxUsageTurns {
		limit = MaxUsageTurns
	}
	where, args := []string{sourceDedup}, []interface{}{}
	if q.Agent != "" {
		where, args = append(where, `agent_name = ?`), append(args, q.Agent)
	}
	if q.Session != "" {
		where, args = append(where, `session_id = ?`), append(args, q.Session)
	}
	if q.Since != "" {
		where, args = append(where, `recorded_at >= ?`), append(args, windowBound(q.Since))
	}
	if q.Until != "" {
		where, args = append(where, `recorded_at < ?`), append(args, q.Until)
	}
	order := `recorded_at DESC, id DESC`
	if q.Order == "cost" {
		order = `cost_usd DESC, recorded_at DESC, id DESC`
	}
	var turns []UsageTurn
	require.NoError(t, s.db.Reader().SelectContext(context.Background(), &turns,
		`SELECT session_id, agent_name, agent_type, COALESCE(board_name, '') AS board_name, COALESCE(model, '') AS model, cost_usd, input_tokens, output_tokens,
		        cache_read_tokens, cache_write_tokens, n_rows, recorded_at
		 FROM token_usage_all WHERE `+strings.Join(where, ` AND `)+` ORDER BY `+order+` LIMIT ?`, append(args, limit)...))
	return turns
}

func TestUsageTurnsAgreeWithTheOldViewQueryOnRandomDatabases(t *testing.T) {
	ctx := context.Background()
	compared, bothTables, nonEmpty := 0, 0, 0
	for seed := int64(1); seed <= 25; seed++ {
		db := openTestDB(t)
		s := NewTokenUsageStore(db)
		a := &aggSeed{t: t, db: db, rng: rand.New(rand.NewSource(seed * 9482))}
		start := aggNow.Add(-240 * time.Hour)
		// sessions: 0-5 jsonl only, 6-7 hook only, 8-9 both (the hook rows of those must not show)
		for i := 0; i < 10; i++ {
			srcs := []string{"jsonl"}
			switch {
			case i == 6 || i == 7:
				srcs = []string{"hook"}
			case i >= 8:
				srcs = []string{"jsonl", "hook"}
			}
			for _, src := range srcs {
				for r, n := 0, 20+a.rng.Intn(60); r < n; r++ {
					a.insert(fmt.Sprintf("s%d", i), storeLayout(a.randomTimeIn(start, aggNow)), src)
				}
			}
		}
		_, rolled, err := db.RollupTokenUsage(ctx, aggNow.Add(-120*time.Hour), 5000)
		require.NoError(t, err)
		require.Greater(t, rolled, int64(10))
		// no raw row and hourly row share both recorded_at and id
		var ties int
		require.NoError(t, db.GetContext(ctx, &ties, `SELECT COUNT(*) FROM token_usage r JOIN token_usage_hourly h ON h.id = r.id AND h.recorded_at = r.recorded_at`))
		require.Zero(t, ties, "the data has no cross-table tie")

		rng := rand.New(rand.NewSource(seed))
		times := []string{"", "2026-10-10T00:00:00Z", "2026-10-13T11:25:00Z", "2026-10-15T20:00:00.5Z", "2026-10-17T00:00:00Z", "2026-10-18T09:00:00Z", "2020-01-01T00:00:00Z", "2027-01-01T00:00:00Z"}
		for k := 0; k < 40; k++ {
			q := UsageTurnsQuery{Order: []string{"", "time", "cost"}[rng.Intn(3)], Limit: []int{0, 1, 5, 20, 50, 200, 500}[rng.Intn(7)], Since: times[rng.Intn(len(times))]}
			if rng.Intn(2) == 0 {
				q.Until = []string{"2026-10-12T05:00:00.000Z", "2026-10-16T12:00:00.000Z", "2026-10-18T14:00:00.000Z"}[rng.Intn(3)]
			}
			if rng.Intn(4) == 0 {
				q.Agent = fmt.Sprintf("agent %d", rng.Intn(10))
			}
			if rng.Intn(5) == 0 {
				q.Session = fmt.Sprintf("s%d", rng.Intn(10))
			}
			want := oldGetUsageTurns(t, s, q)
			got, err := s.GetUsageTurns(ctx, q)
			require.NoError(t, err)
			require.Equal(t, want, got, "seed %d, query %+v", seed, q)
			compared++
			if len(want) > 0 {
				nonEmpty++
			}
			var raw, hourly bool
			for _, tn := range want {
				if tn.NumTurns > 1 {
					hourly = true
				} else {
					raw = true
				}
			}
			if raw && hourly {
				bothTables++
			}
		}
	}
	assert.Greater(t, compared, 900)
	assert.Greater(t, nonEmpty, compared*7/10, "most queries have an answer")
	assert.Greater(t, bothTables, 50, "answers made of rows of both tables were compared")
}

// The default order reads each table through its time index: no scan of the whole table, no view.
func TestUsageTurnsReadEachTableThroughItsTimeIndex(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	query, args := usageTurnsSQL(UsageTurnsQuery{})
	rows, err := db.Reader().QueryxContext(ctx, "EXPLAIN QUERY PLAN "+query, args...)
	require.NoError(t, err)
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		require.NoError(t, rows.Scan(&id, &parent, &unused, &detail))
		plan = append(plan, detail)
	}
	joined := strings.Join(plan, "\n")
	assert.Contains(t, joined, "SCAN token_usage USING INDEX idx_token_usage_time")
	assert.Contains(t, joined, "SCAN token_usage_hourly USING INDEX idx_token_usage_hourly_time")
	assert.NotContains(t, joined, "SCAN token_usage_all")
}
