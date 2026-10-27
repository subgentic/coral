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

// #9442: the efficiency usage read from the day aggregate (coarse: no thinking level, the window runs to now) gives the groups and the sums of the read of every row, with the thinking levels added up:
// the rolled-up hourly rows are read from the day aggregate for the clean whole days, and a row stamped after the window's end is still left out.
func TestEfficiencyUsageCoarseEqualsTheFullRead(t *testing.T) {
	db := openTestDB(t)
	ts := NewTokenUsageStore(db)
	ctx := context.Background()
	a := &aggSeed{t: t, db: db, rng: rand.New(rand.NewSource(9442))}
	start := aggNow.Add(-300 * time.Hour)
	for i := 0; i < 12; i++ {
		for r := 0; r < 150; r++ {
			a.insert(fmt.Sprintf("s%d", i), storeLayout(a.randomTimeIn(start, aggNow)), "jsonl")
		}
	}
	_, err := db.ExecContext(ctx, `UPDATE token_usage SET thinking = CASE id % 3 WHEN 0 THEN 'low' WHEN 1 THEN 'high' ELSE NULL END`)
	require.NoError(t, err)
	_, rolled, err := db.RollupTokenUsage(ctx, aggNow.Add(-100*time.Hour), 5000)
	require.NoError(t, err)
	require.Greater(t, rolled, int64(500))
	_, err = db.RefreshTokenUsageHourAgg(ctx, aggNow, 100000)
	require.NoError(t, err)
	days, err := db.RefreshTokenUsageDayAgg(ctx, aggNow, 1000)
	require.NoError(t, err)
	require.GreaterOrEqual(t, days, 5)
	a.insert("s1", storeLayout(aggNow.Add(time.Hour)), "jsonl") // a stamp in the future: not in a window that ends now
	_, err = db.ExecContext(ctx, `UPDATE token_usage SET thinking = 'high' WHERE recorded_at > ?`, storeLayout(aggNow))
	require.NoError(t, err)

	type key struct{ session, provider, team, model string }
	type sum struct {
		name   string
		tokens int64
		cost   float64
	}
	collapse := func(rows []EfficiencyUsageRow) map[key]sum {
		out := map[key]sum{}
		for _, r := range rows {
			k := key{r.SessionID, r.AgentType, r.Team, r.Model}
			s, seen := out[k]
			if !seen || r.AgentName < s.name {
				s.name = r.AgentName
			}
			s.tokens += r.Tokens
			s.cost += r.CostUSD
			out[k] = s
		}
		return out
	}
	until := aggNow.Format(time.RFC3339)
	usedDay := 0
	for _, since := range []time.Time{aggNow.Add(-7 * 24 * time.Hour), aggNow.Add(-30 * time.Hour), aggNow.Add(-250 * time.Hour), aggNow.Add(-24 * time.Hour)} {
		s := since.Format(time.RFC3339)
		full, err := ts.EfficiencyUsage(ctx, s, until, false)
		require.NoError(t, err)
		coarse, err := ts.EfficiencyUsage(ctx, s, until, true)
		require.NoError(t, err)
		for _, r := range coarse {
			assert.Equal(t, "", r.Thinking, "the coarse read has no thinking level")
		}
		want, got := collapse(full), collapse(coarse)
		require.Equal(t, len(want), len(got), "since %s: the same groups", s)
		for k, w := range want {
			g, ok := got[k]
			require.True(t, ok, "since %s: group %v is missing", s, k)
			assert.Equal(t, w.tokens, g.tokens, "since %s: tokens of %v", s, k)
			assert.InDelta(t, w.cost, g.cost, 1e-6, "since %s: cost of %v", s, k)
			assert.Equal(t, w.name, g.name, "since %s: name of %v", s, k)
		}
		if frag, _ := usageCoarseRelation(ctx, db, s); strings.Contains(frag, "token_usage_day_agg") {
			usedDay++
		}
		var future int64
		for _, r := range coarse {
			future += r.Tokens
		}
		require.NotZero(t, future)
	}
	assert.Greater(t, usedDay, 0, "the day aggregate answered some of the windows")
	// windows that end before now, as the usual window (the seven days before a window) does: whole days from the aggregate inside, the days at both ends from their rows
	midnight := aggNow.Truncate(24 * time.Hour)
	untilDay := 0
	for _, w := range [][2]time.Time{
		{aggNow.Add(-250 * time.Hour), aggNow.Add(-100 * time.Hour)},
		{aggNow.Add(-200 * time.Hour), aggNow.Add(-24*time.Hour + 37*time.Minute)},
		{aggNow.Add(-288 * time.Hour), aggNow.Add(-5 * 24 * time.Hour)},
		{midnight.Add(-9 * 24 * time.Hour), midnight.Add(-2 * 24 * time.Hour)},           // on day boundaries
		{midnight.Add(-9*24*time.Hour + 3*time.Hour), midnight.Add(-2*24*time.Hour - 1)}, // a nanosecond before one
		{aggNow.Add(-30 * time.Hour), aggNow.Add(-27 * time.Hour)},                       // inside one day: nothing of the aggregate
		{aggNow.Add(-400 * time.Hour), aggNow.Add(-300 * time.Hour)},                     // before the data
		{aggNow.Add(-250 * time.Hour), aggNow.Add(-2 * time.Hour)},                       // until inside the day that has no aggregate yet
	} {
		s, u := w[0].Format(time.RFC3339), w[1].Format(time.RFC3339)
		full, err := ts.EfficiencyUsage(ctx, s, u, false)
		require.NoError(t, err)
		coarse, err := ts.EfficiencyUsage(ctx, s, u, true)
		require.NoError(t, err)
		want, got := collapse(full), collapse(coarse)
		require.Equal(t, len(want), len(got), "[%s, %s): the same groups", s, u)
		for k, wv := range want {
			g, ok := got[k]
			require.True(t, ok, "[%s, %s): group %v is missing", s, u, k)
			assert.Equal(t, wv.tokens, g.tokens, "[%s, %s): tokens of %v", s, u, k)
			assert.InDelta(t, wv.cost, g.cost, 1e-6, "[%s, %s): cost of %v", s, u, k)
		}
		if frag, _ := usageCoarseRelationUntil(ctx, db, s, u); strings.Contains(frag, "token_usage_day_agg") {
			untilDay++
		}
	}
	assert.Greater(t, untilDay, 2, "the day aggregate answered several windows that end before now")
	// a day whose hourly rows changed after it was aggregated is dirty: it is read from its rows, whole, until the refresh runs again
	_, err = db.ExecContext(ctx, `INSERT INTO token_usage_hourly(hour, id, session_id, agent_name, agent_type, team_id, board_name, input_tokens, output_tokens, total_tokens, cost_usd, num_turns, recorded_at, cache_read_tokens, cache_write_tokens, session_start_at, last_activity_at, source, model, n_rows, ctx_tokens, thinking)
		VALUES (?, 99999, 's3', 'late', 'claude', NULL, 'alpha', 7, 8, 15, 0.5, 1, ?, 0, 0, NULL, NULL, 'jsonl', 'opus', 1, 15, 'high')`, midnight.Add(-5*24*time.Hour+4*time.Hour).Format("2006-01-02T15"), storeLayout(midnight.Add(-5*24*time.Hour+4*time.Hour)))
	require.NoError(t, err)
	for _, w := range [][2]time.Time{{aggNow.Add(-250 * time.Hour), aggNow.Add(-100 * time.Hour)}, {midnight.Add(-9 * 24 * time.Hour), midnight.Add(-2 * 24 * time.Hour)}, {midnight.Add(-6 * 24 * time.Hour), midnight.Add(-4*24*time.Hour + time.Hour)}} {
		s, u := w[0].Format(time.RFC3339), w[1].Format(time.RFC3339)
		full, err := ts.EfficiencyUsage(ctx, s, u, false)
		require.NoError(t, err)
		coarse, err := ts.EfficiencyUsage(ctx, s, u, true)
		require.NoError(t, err)
		want, got := collapse(full), collapse(coarse)
		require.Equal(t, len(want), len(got), "dirty day, [%s, %s): the same groups", s, u)
		for k, wv := range want {
			assert.Equal(t, wv.tokens, got[k].tokens, "dirty day, [%s, %s): tokens of %v", s, u, k)
		}
	}
	// the future row is in neither read; with no end it is in both
	for _, coarse := range []bool{false, true} {
		open, err := ts.EfficiencyUsage(ctx, aggNow.Add(-24*time.Hour).Format(time.RFC3339), "", coarse)
		require.NoError(t, err)
		closed, err := ts.EfficiencyUsage(ctx, aggNow.Add(-24*time.Hour).Format(time.RFC3339), until, coarse)
		require.NoError(t, err)
		var o, c int64
		for _, r := range open {
			o += r.Tokens
		}
		for _, r := range closed {
			c += r.Tokens
		}
		assert.Greater(t, o, c, "coarse=%v: the row stamped after the end is left out of the window", coarse)
	}
}

// At the size of #9086's baseline (40,000 rolled-up hourly rows over 30 days, 200 sessions, five models, three thinking levels) the coarse read is the same sums from far fewer rows, and faster than the read of every row.
func TestEfficiencyUsageCoarseAtScale(t *testing.T) {
	db := openTestDB(t)
	ts := NewTokenUsageStore(db)
	ctx := context.Background()
	now := time.Now().UTC()
	_, err := db.ExecContext(ctx, `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < 39999)
		INSERT INTO token_usage_hourly(hour, id, session_id, agent_name, agent_type, team_id, board_name, input_tokens, output_tokens, total_tokens, cost_usd, num_turns, recorded_at, cache_read_tokens, cache_write_tokens, session_start_at, last_activity_at, source, model, n_rows, ctx_tokens, thinking)
		SELECT substr(strftime('%Y-%m-%dT%H:%M:%S', ?, '-' || (3*24*60 + (i % 26*24*60) + (i % 1440)) || ' minutes'), 1, 13), i, 'sess-' || (i % 200), 'agent-' || (i % 40), CASE i % 3 WHEN 0 THEN 'claude' WHEN 1 THEN 'codex' ELSE 'pi' END, NULL, 'team-' || (i % 5),
		       100, 50, 150, 0.01, 3, strftime('%Y-%m-%dT%H:%M:%f', ?, '-' || (3*24*60 + (i % 26*24*60) + (i % 1440)) || ' minutes') || '000+00:00', 10, 10, '2026-10-01T00:00:00Z', NULL, 'jsonl', 'model-' || (i % 5), 3, 100, CASE (i / 7) % 4 WHEN 0 THEN 'low' WHEN 1 THEN 'high' ELSE NULL END FROM n`,
		now.Format("2006-01-02 15:04:05"), now.Format("2006-01-02 15:04:05"))
	require.NoError(t, err)
	_, err = db.RefreshTokenUsageDayAgg(ctx, now, 1000)
	require.NoError(t, err)
	since, until := now.Add(-30*24*time.Hour).Format(time.RFC3339), now.Format(time.RFC3339)
	time1 := func(coarse bool) (time.Duration, []EfficiencyUsageRow) {
		var rows []EfficiencyUsageRow
		best := time.Hour
		for i := 0; i < 5; i++ {
			start := time.Now()
			var err error
			rows, err = ts.EfficiencyUsage(ctx, since, until, coarse)
			require.NoError(t, err)
			if d := time.Since(start); d < best {
				best = d
			}
		}
		return best, rows
	}
	fullT, full := time1(false)
	coarseT, coarse := time1(true)
	var ft, ct int64
	for _, r := range full {
		ft += r.Tokens
	}
	for _, r := range coarse {
		ct += r.Tokens
	}
	require.NotEmpty(t, full)
	assert.Equal(t, ft, ct, "the same tokens")
	assert.Less(t, len(coarse), len(full), "fewer groups without the thinking level")
	t.Logf("30 days, 40,000 hourly rows: every row %v (%d groups), day aggregate %v (%d groups)", fullT, len(full), coarseT, len(coarse))
	assert.Less(t, coarseT, fullT, "the coarse read is the faster one")
}
