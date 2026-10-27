package store

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// #9337: the summaries read the rolled-up hourly rows through the day aggregate where it is current and the hourly rows elsewhere. Old against
// new, as for the hour aggregate (token_usage_hour_agg_test.go): every summary, every window, at every stage of the aggregate's life, with it
// switched off and on.

func TestUsageSummariesThroughTheDayAggregateMatchTheHourlyRows(t *testing.T) {
	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	a := &aggSeed{t: t, db: db, rng: rand.New(rand.NewSource(9337))}
	start := aggNow.Add(-300 * time.Hour)
	for i := 0; i < 12; i++ {
		for _, src := range []string{"jsonl", "hook"}[:1+i/10] {
			for r := 0; r < 150; r++ {
				a.insert(fmt.Sprintf("s%d", i), storeLayout(a.randomTimeIn(start, aggNow)), src)
			}
		}
	}
	for i := 0; i < 12; i += 2 {
		_, err := db.ExecContext(ctx, `INSERT INTO git_snapshots (agent_name, agent_type, working_directory, branch, commit_hash, session_id, remote_url, recorded_at) VALUES (?, 'claude', '/w', ?, ?, ?, 'https://x/y', '2026-10-18T10:00:00Z')`,
			fmt.Sprintf("agent %d", i), fmt.Sprintf("branch-%d", i%4), fmt.Sprintf("c%d", i), fmt.Sprintf("s%d", i))
		require.NoError(t, err)
	}
	// the oldest 200 hours become hourly rows, as the retention job does: about eight days of them
	_, rolled, err := db.RollupTokenUsage(ctx, aggNow.Add(-100*time.Hour), 5000)
	require.NoError(t, err)
	require.Greater(t, rolled, int64(500))
	_, err = db.RefreshTokenUsageHourAgg(ctx, aggNow, 100000)
	require.NoError(t, err)

	sinces := append(aggSinces(), "2026-10-08T00:00:00Z", "2026-10-09T10:00:00Z", "2026-10-12T00:00:00.000000+00:00", "2026-10-13T23:59:59Z")
	var withDay int
	compare := func(stage string, wantDay bool) {
		t.Helper()
		for _, since := range sinces {
			tokenUsageDayAggOn = true
			frag, _ := usageCoarseRelation(ctx, db, since)
			got := costAnswersFor(t, s, since)
			tokenUsageDayAggOn = false
			want := costAnswersFor(t, s, since)
			tokenUsageDayAggOn = true
			for k := range want {
				require.Equal(t, normalizeJSON(t, want[k]), normalizeJSON(t, got[k]), "%s: since %q, %s", stage, since, k)
			}
			if strings.Contains(frag, "token_usage_day_agg") {
				withDay++
			}
		}
		if wantDay {
			require.Greater(t, withDay, 0, stage+": the day aggregate answered some windows")
		}
	}
	t.Cleanup(func() { tokenUsageDayAggOn = true })

	compare("before the first refresh", false)
	require.Zero(t, withDay, "an aggregate that is empty is not read")

	days, err := db.RefreshTokenUsageDayAgg(ctx, aggNow, 1000)
	require.NoError(t, err)
	require.GreaterOrEqual(t, days, 5)
	var left, agg, hourly int
	require.NoError(t, db.GetContext(ctx, &left, `SELECT COUNT(*) FROM token_usage_day_dirty`))
	require.NoError(t, db.GetContext(ctx, &agg, `SELECT COUNT(*) FROM token_usage_day_agg`))
	require.NoError(t, db.GetContext(ctx, &hourly, `SELECT COUNT(*) FROM token_usage_hourly`))
	require.Zero(t, left)
	require.Less(t, agg*2, hourly, "the aggregate has fewer rows than the hourly table")
	withDay = 0
	compare("built", true)
	require.GreaterOrEqual(t, withDay, 6)

	refresh := func() {
		_, err := db.RefreshTokenUsageDayAgg(ctx, aggNow, 1000)
		require.NoError(t, err)
	}
	change := func(stage string, do func()) {
		t.Helper()
		refresh()
		do()
		require.NoError(t, db.GetContext(ctx, &left, `SELECT COUNT(*) FROM token_usage_day_dirty`))
		require.Greater(t, left, 0, stage+": the change marked its day")
		withDay = 0
		compare(stage+", before the refresh", true)
		refresh()
		withDay = 0
		compare(stage+", after the refresh", true)
	}
	change("an hourly row changed in place", func() {
		_, err := db.ExecContext(ctx, `UPDATE token_usage_hourly SET cost_usd = cost_usd + 7, input_tokens = input_tokens + 5 WHERE id = (SELECT MAX(id) FROM token_usage_hourly WHERE session_id = 's1')`)
		require.NoError(t, err)
	})
	change("an hourly row deleted", func() {
		_, err := db.ExecContext(ctx, `DELETE FROM token_usage_hourly WHERE id = (SELECT MIN(id) FROM token_usage_hourly WHERE session_id = 's2')`)
		require.NoError(t, err)
	})
	change("an hourly row moved to another day", func() {
		_, err := db.ExecContext(ctx, `UPDATE token_usage_hourly SET recorded_at = '2026-10-11T05:30:00.000000+00:00', hour = '2026-10-11T05' WHERE id = (SELECT MIN(id) FROM token_usage_hourly WHERE session_id = 's5')`)
		require.NoError(t, err)
	})
	change("an hourly row added", func() {
		_, err := db.ExecContext(ctx, `INSERT INTO token_usage_hourly (hour, session_id, agent_name, agent_type, input_tokens, output_tokens, total_tokens, cost_usd, num_turns, recorded_at, cache_read_tokens, cache_write_tokens, source, model, n_rows, ctx_tokens)
			VALUES ('2026-10-12T07', 's3', 'agent 3', 'claude', 5, 6, 11, 1.5, 1, '2026-10-12T07:15:00.000000+00:00', 1, 2, 'jsonl', 'opus', 3, 8)`)
		require.NoError(t, err)
	})

	// rows in other layouts: their day is listed odd and read from the hourly rows from then on
	_, err = db.ExecContext(ctx, `INSERT INTO token_usage_hourly (hour, session_id, agent_name, agent_type, input_tokens, output_tokens, total_tokens, cost_usd, num_turns, recorded_at, cache_read_tokens, cache_write_tokens, source, model, n_rows, ctx_tokens)
		VALUES ('2026-10-12T09', 's3', 'agent 3', 'claude', 5, 6, 11, 2.5, 1, '2026-10-12 09:15:00', 1, 2, 'jsonl', 'opus', 3, 8)`)
	require.NoError(t, err)
	refresh()
	withDay = 0
	compare("with a row in another layout", true)
	var odd int
	require.NoError(t, db.GetContext(ctx, &odd, `SELECT COUNT(*) FROM token_usage_day_odd`))
	require.GreaterOrEqual(t, odd, 1)

	// a restart builds nothing twice and changes no answer
	require.NoError(t, db.ensureTokenUsageDayAgg(ctx))
	withDay = 0
	compare("after another start", true)
}

// 30,000 rolled-up hourly rows (20 sessions, 28 days, 3 models): the day aggregate gives the same summaries and is much faster. The times are logged;
// the assertion is a gross one (timing tests flake).
func TestUsageSummariesAt30kHourlyRows(t *testing.T) {
	if testing.Short() {
		t.Skip("30k rows")
	}
	db := openTestDB(t)
	s := NewTokenUsageStore(db)
	ctx := context.Background()
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	tx, err := db.BeginTxx(ctx, nil)
	require.NoError(t, err)
	n := 0
	for sess := 0; sess < 20; sess++ {
		for h := 0; h < 28*24; h++ {
			at := now.Add(-time.Duration(h+30) * time.Hour)
			for m, model := range []string{"opus", "sonnet", "haiku"} {
				if (h+m+sess)%4 == 0 {
					continue // not every model every hour
				}
				n++
				_, err := tx.ExecContext(ctx, `INSERT INTO token_usage_hourly (hour, session_id, agent_name, agent_type, team_id, board_name, input_tokens, output_tokens, total_tokens, cost_usd, num_turns, recorded_at, cache_read_tokens, cache_write_tokens, source, model, n_rows, ctx_tokens)
					VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, 3, 4, 'jsonl', ?, 2, 9)`,
					at.Format("2006-01-02T15"), fmt.Sprintf("sess-%d", sess), fmt.Sprintf("agent %d", sess), []string{"claude", "codex"}[sess%2], []string{"alpha", "beta"}[sess%2],
					100+m, 50+sess, 150+m+sess, float64(h%7)/100+0.01, at.Format("2006-01-02T15:04:05.000000")+"+00:00", model)
				require.NoError(t, err)
			}
		}
	}
	require.NoError(t, tx.Commit())
	require.Greater(t, n, 30000)
	days, err := db.RefreshTokenUsageDayAgg(ctx, now, 1000)
	require.NoError(t, err)
	require.GreaterOrEqual(t, days, 28)
	t.Cleanup(func() { tokenUsageDayAggOn = true })

	since := now.AddDate(0, 0, -30).Format(time.RFC3339)
	best := func(on bool) time.Duration {
		tokenUsageDayAggOn = on
		d := time.Hour
		for i := 0; i < 3; i++ {
			t0 := time.Now()
			_, err := s.GetUsageSummary(ctx, since)
			require.NoError(t, err)
			_, err = s.GetUsageSummaryByAgent(ctx, since)
			require.NoError(t, err)
			_, err = s.GetUsageSummaryByModel(ctx, since)
			require.NoError(t, err)
			d = min(d, time.Since(t0))
		}
		return d
	}
	fine, coarse := best(false), best(true)
	t.Logf("%d hourly rows, the three summaries of the Cost view: hourly rows %v, day aggregate %v", n, fine, coarse)
	for _, w := range []string{since, "", now.AddDate(0, 0, -9).Add(37 * time.Minute).Format(time.RFC3339)} {
		tokenUsageDayAggOn = true
		got := costAnswersFor(t, s, w)
		tokenUsageDayAggOn = false
		want := costAnswersFor(t, s, w)
		tokenUsageDayAggOn = true
		for k := range want {
			require.Equal(t, normalizeJSON(t, want[k]), normalizeJSON(t, got[k]), "since %q, %s", w, k)
		}
	}
	require.Less(t, coarse*3, fine, "the day aggregate is at least three times faster")
}
