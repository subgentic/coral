package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #9507: Analytics correctness end to end. Coral Hub builds against these routes, so each route's numbers are compared with a plain SQL over the stored rows (token_usage and token_usage_hourly, joined
// by nothing, summed by the query in this file and by nothing the routes use), for windows that start mid-day, across midnight, 36 hours, 3 days (the edge of the rolled-up hours), 7 and 30 days, and for
// the groupings each route has. The data is what a server holds after a month: raw rows, the older ones rolled up into hourly rows by the retention job, the hour and day aggregates refreshed, sessions
// of the three source shapes (transcript only, hook only, both), models and thinking levels recorded and not, boards recorded and taken from the live row. Window starts are whole seconds.

type corrSeed struct {
	sess                 string
	name, typ, board     string
	model, thinking      string
	source               string
	in, out, cr, cw      int64
	cost                 float64
	at                   time.Time
	boardNull, modelNull bool
}

func seedAnalytics(t *testing.T, now time.Time) (*store.DB, *TokenUsageHandler, *EfficiencyHandler, map[string]corrSum) {
	t.Helper()
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ss := store.NewSessionStore(db)
	rng := rand.New(rand.NewSource(9507))
	types := []string{"claude", "codex", "pi", "agy"}
	models := []string{"opus", "sonnet", "haiku", "gpt-5", ""}
	levels := []string{"", "low", "high"}
	boards := []string{"alpha", "beta", "", "gamma"}
	for i := 0; i < 24; i++ {
		if i < 12 {
			b := "live-" + fmt.Sprint(i%3)
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: fmt.Sprintf("sess-%d", i), AgentName: fmt.Sprintf("Agent %d", i), AgentType: types[i%4], WorkingDir: "/w", BoardName: &b}))
		}
	}
	srcOf := func(i int, k int) string {
		switch {
		case i >= 22: // both transcripts and hooks: the hook rows are the same usage and are not counted twice
			return []string{"jsonl", "hook"}[k%2]
		case i >= 20:
			return "hook"
		}
		return "jsonl"
	}
	for n := 0; n < 3600; n++ {
		i := rng.Intn(24)
		ago := time.Duration(rng.Int63n(int64(35 * 24 * time.Hour)))
		at := now.Add(-ago).Add(-time.Duration(rng.Intn(1000000)) * time.Microsecond)
		row := corrSeed{sess: fmt.Sprintf("sess-%d", i), name: fmt.Sprintf("Agent %d", i), typ: types[i%4], board: boards[i%4], model: models[rng.Intn(len(models))], thinking: levels[rng.Intn(3)], source: srcOf(i, n),
			in: int64(100 + rng.Intn(900)), out: int64(10 + rng.Intn(300)), cr: int64(rng.Intn(500)), cw: int64(rng.Intn(100)), cost: float64(rng.Intn(900)) / 100, at: at}
		var board, model, thinking any
		if i >= 12 || n%3 != 0 { // the first twelve sessions often have no board recorded: the live row says
			if row.board != "" {
				board = row.board
			}
		}
		if row.model != "" {
			model = row.model
		}
		if row.thinking != "" {
			thinking = row.thinking
		}
		_, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO token_usage(session_id, agent_name, agent_type, team_id, board_name, input_tokens, output_tokens, total_tokens, cost_usd, num_turns, recorded_at, cache_read_tokens, cache_write_tokens, source, model, thinking)
			VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`, row.sess, row.name, row.typ, board, row.in, row.out, row.in+row.out, row.cost, at.UTC().Format(store.ISOFormat), row.cr, row.cw, row.source, model, thinking)
		require.NoError(t, err)
	}
	before := corrQuery(t, db, "agent_type", now.Add(-40*24*time.Hour).Format(time.RFC3339)) // what the raw rows say, before the retention job rolls any up
	// the retention job's work: raw rows older than three days become hourly rows, then the aggregates are refreshed
	_, rolled, err := db.RollupTokenUsage(ctx, now.Add(-3*24*time.Hour), 100000)
	require.NoError(t, err)
	require.Greater(t, rolled, int64(1000))
	_, err = db.RefreshTokenUsageHourAgg(ctx, now, 100000)
	require.NoError(t, err)
	_, err = db.RefreshTokenUsageDayAgg(ctx, now, 1000)
	require.NoError(t, err)
	// commits, so that every provider has some in the efficiency windows
	gs := store.NewGitStore(db)
	for k := 0; k < 120; k++ {
		i := k % 20
		at := now.Add(-time.Duration(rng.Int63n(int64(29 * 24 * time.Hour)))).Format(time.RFC3339)
		sid := fmt.Sprintf("sess-%d", i)
		require.NoError(t, gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: fmt.Sprintf("Agent %d", i), AgentType: types[i%4], WorkingDirectory: "/w", Branch: fmt.Sprintf("b%d", i%5), CommitHash: fmt.Sprintf("c%d", k), CommitTimestamp: &at, SessionID: &sid}))
	}
	eh := NewEfficiencyHandler(db, bs)
	eh.now = func() time.Time { return now }
	return db, NewTokenUsageHandler(db), eh, before
}

// the oracle: the stored rows, plainly. Hook rows of a session that has transcript rows are the same usage and are left out; a window is the rows stamped at or after since.
const corrUnion = `WITH u AS (
	SELECT session_id, agent_name, agent_type, board_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_read_tokens, cache_write_tokens, COALESCE(source, 'jsonl') AS source, 1 AS n, recorded_at FROM token_usage
	UNION ALL
	SELECT session_id, agent_name, agent_type, board_name, model, input_tokens, output_tokens, total_tokens, cost_usd, cache_read_tokens, cache_write_tokens, COALESCE(source, 'jsonl'), n_rows, recorded_at FROM token_usage_hourly
), w AS (
	SELECT u.*, COALESCE(NULLIF(u.board_name, ''), ls.board_name, '') AS team FROM u LEFT JOIN live_sessions ls ON ls.session_id = u.session_id
	WHERE (u.source = 'jsonl' OR u.session_id NOT IN (SELECT session_id FROM u WHERE source = 'jsonl')) AND julianday(u.recorded_at) >= julianday(?) AND julianday(u.recorded_at) < julianday(?)
)
`

type corrSum struct {
	Key                        string
	In, Out, CR, CW, Tokens, N int64
	Cost                       float64
	Sessions                   int
}

func corrQuery(t *testing.T, db *store.DB, group string, since string, until ...string) map[string]corrSum {
	t.Helper()
	end := "9999-12-31T00:00:00Z"
	if len(until) > 0 {
		end = until[0]
	}
	var rows []struct {
		K        string  `db:"k"`
		In       int64   `db:"i"`
		Out      int64   `db:"o"`
		CR       int64   `db:"cr"`
		CW       int64   `db:"cw"`
		Tokens   int64   `db:"tk"`
		Cost     float64 `db:"c"`
		N        int64   `db:"n"`
		Sessions int     `db:"s"`
	}
	require.NoError(t, db.SelectContext(context.Background(), &rows, corrUnion+`SELECT `+group+` AS k, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw, SUM(total_tokens) AS tk, SUM(cost_usd) AS c, SUM(n) AS n, COUNT(DISTINCT session_id) AS s FROM w GROUP BY k`, since, end))
	out := map[string]corrSum{}
	for _, r := range rows {
		out[r.K] = corrSum{Key: r.K, In: r.In, Out: r.Out, CR: r.CR, CW: r.CW, Tokens: r.Tokens, N: r.N, Cost: r.Cost, Sessions: r.Sessions}
	}
	return out
}

func corrGetJSON(t *testing.T, h http.HandlerFunc, target string, into any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, target, nil))
	require.Equal(t, http.StatusOK, rec.Code, target+": "+rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), into))
}

func near(a, b float64) bool { return math.Abs(a-b) <= 1e-6*math.Max(1, math.Abs(b)) }

func TestAnalyticsRoutesMatchPlainSQL(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	db, th, eh, before := seedAnalytics(t, now)
	t.Run("rolling raw rows up keeps every sum", func(t *testing.T) {
		after := corrQuery(t, db, "agent_type", now.Add(-40*24*time.Hour).Format(time.RFC3339))
		require.Len(t, after, len(before))
		for k, b := range before {
			a := after[k]
			assert.Equal(t, [6]int64{b.In, b.Out, b.CR, b.CW, b.Tokens, b.N}, [6]int64{a.In, a.Out, a.CR, a.CW, a.Tokens, a.N}, "%s: sums and calls", k)
			assert.Equal(t, b.Sessions, a.Sessions, "%s: sessions", k)
			assert.True(t, near(b.Cost, a.Cost), "%s: cost", k)
		}
	})
	midnight := now.Truncate(24 * time.Hour)
	windows := map[string]time.Time{
		"30 days":                            now.Add(-30 * 24 * time.Hour),
		"7 days":                             now.Add(-7 * 24 * time.Hour),
		"3 days (the rolled-up hours' edge)": now.Add(-3 * 24 * time.Hour),
		"36 hours":                           now.Add(-36 * time.Hour),
		"across midnight":                    midnight.Add(-30 * time.Minute),
		"mid-day yesterday":                  midnight.Add(-12 * time.Hour),
		"mid-hour":                           now.Add(-5*24*time.Hour - 17*time.Minute - 23*time.Second),
		"all of it":                          now.Add(-40 * 24 * time.Hour),
	}
	for name, since := range windows {
		s := since.Format(time.RFC3339)
		q := url.Values{"since": {s}}.Encode()
		t.Run(name, func(t *testing.T) {
			// the usage summary: by agent type, by model, the totals
			var sum struct {
				ByType  []store.UsageSummary      `json:"by_agent_type"`
				ByModel []store.ModelUsageSummary `json:"by_model"`
				ByAgent []store.AgentUsageSummary `json:"by_agent"`
				Totals  map[string]float64        `json:"totals"`
			}
			corrGetJSON(t, th.UsageSummary, "/?"+q, &sum)
			wantType := corrQuery(t, db, "agent_type", s)
			require.Len(t, sum.ByType, len(wantType), "agent types")
			var tot corrSum
			for _, g := range sum.ByType {
				w := wantType[g.AgentType]
				assert.Equal(t, [6]int64{w.In, w.Out, w.CR, w.CW, w.Tokens, w.N}, [6]int64{g.InputTokens, g.OutputTokens, g.CacheReadTokens, g.CacheWriteTokens, g.TotalTokens, g.NumRequests}, "by agent type %s: tokens and requests", g.AgentType)
				assert.True(t, near(w.Cost, g.CostUSD), "by agent type %s: cost %v want %v", g.AgentType, g.CostUSD, w.Cost)
				assert.Equal(t, w.Sessions, g.NumSessions, "by agent type %s: sessions", g.AgentType)
				tot.Tokens += w.Tokens
				tot.N += w.N
				tot.Cost += w.Cost
			}
			assert.Equal(t, float64(tot.Tokens), sum.Totals["total_tokens"], "totals: tokens")
			assert.Equal(t, float64(tot.N), sum.Totals["num_requests"], "totals: requests")
			assert.True(t, near(tot.Cost, sum.Totals["cost_usd"]), "totals: cost")
			wantModel := corrQuery(t, db, "agent_type || '|' || COALESCE(model, '')", s)
			require.Len(t, sum.ByModel, len(wantModel), "agent type and model")
			for _, g := range sum.ByModel {
				w := wantModel[g.AgentType+"|"+g.Model]
				assert.Equal(t, [5]int64{w.In, w.Out, w.CR, w.CW, w.N}, [5]int64{g.InputTokens, g.OutputTokens, g.CacheReadTokens, g.CacheWriteTokens, g.NumRequests}, "by model %s/%s", g.AgentType, g.Model)
				assert.True(t, near(w.Cost, g.CostUSD), "by model %s/%s: cost", g.AgentType, g.Model)
			}
			wantAgent := corrQuery(t, db, "session_id", s)
			require.Len(t, sum.ByAgent, len(wantAgent), "agents (sessions)")
			for _, g := range sum.ByAgent {
				w := wantAgent[g.SessionID]
				assert.Equal(t, [5]int64{w.In, w.Out, w.CR, w.CW, w.Tokens}, [5]int64{g.InputTokens, g.OutputTokens, g.CacheReadTokens, g.CacheWriteTokens, g.TotalTokens}, "by agent %s", g.SessionID)
				assert.Equal(t, int(w.N), g.NumRecords, "by agent %s: requests", g.SessionID)
				assert.True(t, near(w.Cost, g.CostUSD), "by agent %s: cost", g.SessionID)
			}

			// by team (the board the row recorded, else its live row's)
			var teams struct {
				Teams []store.BoardUsageSummary `json:"teams"`
			}
			corrGetJSON(t, th.UsageSummaryByBoard, "/?"+q, &teams)
			wantTeam := corrQuery(t, db, "team", s)
			for _, g := range teams.Teams {
				w, ok := wantTeam[g.BoardName]
				require.True(t, ok, "team %q is not in the stored rows", g.BoardName)
				assert.Equal(t, [5]int64{w.In, w.Out, w.CR, w.CW, w.Tokens}, [5]int64{g.InputTokens, g.OutputTokens, g.CacheReadTokens, g.CacheWriteTokens, g.TotalTokens}, "by team %q", g.BoardName)
				assert.True(t, near(w.Cost, g.CostUSD), "by team %q: cost", g.BoardName)
			}
			assert.Equal(t, len(wantTeam), len(teams.Teams), "the same teams (the usage with no board is one row with no name)")

			// the time series, hourly and daily
			for _, iv := range []struct{ name, expr string }{{"1h", `strftime('%Y-%m-%dT%H:00:00Z', recorded_at)`}, {"1d", `strftime('%Y-%m-%dT00:00:00Z', recorded_at)`}} {
				var ts struct {
					Buckets []struct {
						Bucket      string  `json:"bucket"`
						Cost        float64 `json:"cost_usd"`
						In          int64   `json:"input_tokens"`
						Out         int64   `json:"output_tokens"`
						CR          int64   `json:"cache_read_tokens"`
						CW          int64   `json:"cache_write_tokens"`
						NumRequests int     `json:"num_requests"`
					} `json:"buckets"`
				}
				corrGetJSON(t, th.UsageTimeSeries, "/?"+q+"&interval="+iv.name, &ts)
				want := corrQuery(t, db, iv.expr, s)
				require.Len(t, ts.Buckets, len(want), "%s buckets", iv.name)
				for _, b := range ts.Buckets {
					w, ok := want[b.Bucket]
					require.True(t, ok, "%s bucket %s is not in the stored rows", iv.name, b.Bucket)
					assert.Equal(t, [5]int64{w.In, w.Out, w.CR, w.CW, w.N}, [5]int64{b.In, b.Out, b.CR, b.CW, int64(b.NumRequests)}, "%s bucket %s", iv.name, b.Bucket)
					assert.True(t, near(w.Cost, b.Cost), "%s bucket %s: cost %v want %v", iv.name, b.Bucket, b.Cost, w.Cost)
				}
			}
		})
	}

	// windows that end before now: the time series takes an until (mid-day, mid-hour, on midnight), as the dashboard's earlier windows do
	for name, w := range map[string][2]time.Time{
		"7 days to mid-day yesterday":       {now.Add(-7 * 24 * time.Hour), midnight.Add(-12 * time.Hour)},
		"30 days to 3 days and 5 hours ago": {now.Add(-30 * 24 * time.Hour), now.Add(-3*24*time.Hour - 5*time.Hour - 11*time.Minute - 7*time.Second)},
		"yesterday midnight to midnight":    {midnight.Add(-24 * time.Hour), midnight},
		"inside one rolled-up day":          {midnight.Add(-8*24*time.Hour + 4*time.Hour), midnight.Add(-8*24*time.Hour + 19*time.Hour)},
	} {
		s, u := w[0].Format(time.RFC3339), w[1].Format(time.RFC3339)
		for _, iv := range []struct{ name, expr string }{{"1h", `strftime('%Y-%m-%dT%H:00:00Z', recorded_at)`}, {"1d", `strftime('%Y-%m-%dT00:00:00Z', recorded_at)`}} {
			t.Run("series "+iv.name+" "+name, func(t *testing.T) {
				var ts struct {
					Buckets []struct {
						Bucket      string  `json:"bucket"`
						Cost        float64 `json:"cost_usd"`
						In          int64   `json:"input_tokens"`
						Out         int64   `json:"output_tokens"`
						NumRequests int     `json:"num_requests"`
					} `json:"buckets"`
				}
				corrGetJSON(t, th.UsageTimeSeries, "/?"+url.Values{"since": {s}, "until": {u}, "interval": {iv.name}}.Encode(), &ts)
				want := corrQuery(t, db, iv.expr, s, u)
				require.Len(t, ts.Buckets, len(want), "buckets")
				for _, b := range ts.Buckets {
					w, ok := want[b.Bucket]
					require.True(t, ok, "bucket %s is not in the stored rows", b.Bucket)
					assert.Equal(t, [3]int64{w.In, w.Out, w.N}, [3]int64{b.In, b.Out, int64(b.NumRequests)}, "bucket %s", b.Bucket)
					assert.True(t, near(w.Cost, b.Cost), "bucket %s: cost %v want %v", b.Bucket, b.Cost, w.Cost)
				}
			})
		}
	}

	// the turns: the newest and the dearest of a window (raw rows and rolled-up hours alike), as the stored rows order them
	for name, w := range map[string][2]time.Time{
		"7 days":                       {now.Add(-7 * 24 * time.Hour), now},
		"30 days":                      {now.Add(-30 * 24 * time.Hour), now},
		"20 days to mid-day yesterday": {now.Add(-20 * 24 * time.Hour), midnight.Add(-12 * time.Hour)},
	} {
		s, u := w[0].Format(time.RFC3339), w[1].Add(time.Second).Format(time.RFC3339) // until is exclusive: the second after now keeps the newest row
		if name != "7 days" && name != "30 days" {
			u = w[1].Format(time.RFC3339)
		}
		for _, order := range []string{"time", "cost"} {
			t.Run("turns "+order+" "+name, func(t *testing.T) {
				var got struct {
					Turns []store.UsageTurn `json:"turns"`
				}
				corrGetJSON(t, th.UsageTurns, "/?"+url.Values{"since": {s}, "until": {u}, "order": {order}, "limit": {"25"}}.Encode(), &got)
				orderBy := "recorded_at DESC"
				if order == "cost" {
					orderBy = "cost_usd DESC, recorded_at DESC"
				}
				var want []struct {
					Session string  `db:"session_id"`
					At      string  `db:"recorded_at"`
					Cost    float64 `db:"cost_usd"`
					In      int64   `db:"input_tokens"`
					Out     int64   `db:"output_tokens"`
					N       int     `db:"n"`
				}
				require.NoError(t, db.SelectContext(context.Background(), &want, corrUnion+`SELECT session_id, recorded_at, cost_usd, input_tokens, output_tokens, n FROM w WHERE julianday(recorded_at) < julianday(?) ORDER BY `+orderBy+` LIMIT 25`, s, u, u))
				require.Len(t, got.Turns, len(want), "turns")
				for i, g := range got.Turns {
					assert.Equal(t, want[i].Session, g.SessionID, "turn %d: session", i)
					assert.Equal(t, [3]int64{want[i].In, want[i].Out, int64(want[i].N)}, [3]int64{g.InputTokens, g.OutputTokens, int64(g.NumTurns)}, "turn %d: tokens and calls", i)
					assert.True(t, near(want[i].Cost, g.CostUSD), "turn %d: cost %v want %v", i, g.CostUSD, want[i].Cost)
				}
			})
		}
	}

	// efficiency: a group's tokens are the usage of its providers and models in the window the range names (the measured CLIs), whichever rows that usage is made of
	for _, rng := range []struct {
		name string
		d    time.Duration
	}{{"24h", 24 * time.Hour}, {"7d", 7 * 24 * time.Hour}, {"30d", 30 * 24 * time.Hour}} {
		for _, dim := range []struct{ group, expr string }{{"provider", "agent_type"}, {"model", "COALESCE(model, '')"}, {"team", "team"}} {
			t.Run("efficiency "+rng.name+" by "+dim.group, func(t *testing.T) {
				var got struct {
					Groups []struct {
						Key    string `json:"key"`
						Tokens int64  `json:"tokens"`
					} `json:"groups"`
				}
				corrGetJSON(t, eh.Efficiency, "/?metric=tokens_per_commit&group_by="+dim.group+"&range="+rng.name, &got)
				require.NotEmpty(t, got.Groups, "groups")
				want := corrQuery(t, db, dim.expr, now.Add(-rng.d).Format(time.RFC3339))
				measured := map[string]bool{"claude": true, "codex": true, "pi": true, "agy": true}
				for _, g := range got.Groups {
					if g.Key == "" && dim.group != "model" {
						continue
					}
					w, ok := want[g.Key]
					if !ok {
						continue // a group named by the commits' dominant level or label, not a stored key
					}
					if dim.group == "provider" {
						require.True(t, measured[g.Key], "a provider that is measured: %s", g.Key)
					}
					assert.Equal(t, w.In+w.Out, g.Tokens, "efficiency %s %s: tokens (input + output) of %s", rng.name, dim.group, g.Key)
				}
			})
		}
	}
}
