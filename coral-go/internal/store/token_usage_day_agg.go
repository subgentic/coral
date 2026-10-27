package store

import (
	"context"
	"fmt"
	"time"
)

// The rolled-up hourly rows (token_usage_hourly) are the bulk of an install's usage: raw rows older than a few days become one row per session,
// hour and model, and at 40,000 rows a 30-day Cost summary read all of them four times (p95 370 ms, #9086, Goal #85). The queries that group by
// session, agent, model, board or branch do not need the hour, so token_usage_day_agg holds the hourly rows summed by day and by every column those
// queries group by (the same key as token_usage_hour_agg): about 24 times fewer rows.
//
// It is derived data, kept exact the way the hour aggregate is: triggers on token_usage_hourly mark a day dirty (token_usage_day_dirty) when any
// writer inserts, changes or deletes a row of it, the refresh recomputes a dirty day that is over in one transaction, and a day with a row whose
// recorded_at is not a canonical UTC timestamp is listed in token_usage_day_odd and never aggregated. A query that takes the coarse relation reads
// the aggregate for the clean days that lie wholly inside its window and the hourly rows for every other day (the day the window begins in, dirty
// and odd days, days after the last aggregated one), so it gives the numbers the hourly rows give.

var tokenUsageDayAggSQL = `
CREATE TABLE IF NOT EXISTS token_usage_day_agg (
	day                TEXT NOT NULL,   -- the first 10 characters of recorded_at (2006-01-02), a UTC day
	session_id         TEXT NOT NULL,
	agent_name         TEXT NOT NULL,
	agent_type         TEXT NOT NULL,
	team_id            INTEGER,
	board_name         TEXT,
	source             TEXT NOT NULL,
	model              TEXT,
	input_tokens       INTEGER NOT NULL,
	output_tokens      INTEGER NOT NULL,
	total_tokens       INTEGER NOT NULL,
	cache_read_tokens  INTEGER NOT NULL,
	cache_write_tokens INTEGER NOT NULL,
	cost_usd           REAL NOT NULL,
	n_rows             INTEGER NOT NULL,
	min_at             TEXT NOT NULL,   -- the earliest and the latest recorded_at it sums
	max_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_day_agg_day ON token_usage_day_agg(day);
CREATE TABLE IF NOT EXISTS token_usage_day_dirty (day TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS token_usage_day_odd (day TEXT PRIMARY KEY) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS token_usage_day_dirty_insert AFTER INSERT ON token_usage_hourly BEGIN
	INSERT OR IGNORE INTO token_usage_day_dirty VALUES (substr(NEW.recorded_at, 1, 10));
END;
CREATE TRIGGER IF NOT EXISTS token_usage_day_dirty_update AFTER UPDATE ON token_usage_hourly BEGIN
	INSERT OR IGNORE INTO token_usage_day_dirty VALUES (substr(OLD.recorded_at, 1, 10));
	INSERT OR IGNORE INTO token_usage_day_dirty VALUES (substr(NEW.recorded_at, 1, 10));
END;
CREATE TRIGGER IF NOT EXISTS token_usage_day_dirty_delete AFTER DELETE ON token_usage_hourly BEGIN
	INSERT OR IGNORE INTO token_usage_day_dirty VALUES (substr(OLD.recorded_at, 1, 10));
END;
CREATE TRIGGER IF NOT EXISTS token_usage_day_odd_insert AFTER INSERT ON token_usage_hourly WHEN NOT ` + canonicalUsageTimeOf("NEW.recorded_at") + ` BEGIN
	INSERT OR IGNORE INTO token_usage_day_odd VALUES (substr(NEW.recorded_at, 1, 10));
END;
CREATE TRIGGER IF NOT EXISTS token_usage_day_odd_update AFTER UPDATE ON token_usage_hourly WHEN NOT ` + canonicalUsageTimeOf("NEW.recorded_at") + ` BEGIN
	INSERT OR IGNORE INTO token_usage_day_odd VALUES (substr(NEW.recorded_at, 1, 10));
END;
`

// ensureTokenUsageDayAgg creates the aggregate, the lists and the triggers and, the first time, marks every day of the hourly rows dirty (so the
// refresh builds them) and lists the odd ones. One write transaction: no insert can land between the marking and the triggers.
func (d *DB) ensureTokenUsageDayAgg(ctx context.Context) error {
	tx, err := d.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var existed int
	if err := tx.GetContext(ctx, &existed, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'token_usage_day_agg'`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, tokenUsageDayAggSQL); err != nil {
		return fmt.Errorf("create token usage day aggregate: %w", err)
	}
	if existed == 0 {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO token_usage_day_dirty SELECT DISTINCT substr(recorded_at, 1, 10) FROM token_usage_hourly`); err != nil {
			return fmt.Errorf("mark token usage days: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO token_usage_day_odd SELECT DISTINCT substr(recorded_at, 1, 10) FROM token_usage_hourly WHERE NOT `+canonicalUsageTimeOf("recorded_at")); err != nil {
			return fmt.Errorf("list odd token usage days: %w", err)
		}
	}
	return tx.Commit()
}

var refreshTokenUsageDaySQL = `
INSERT INTO token_usage_day_agg
SELECT ?1, session_id, agent_name, agent_type, team_id, board_name, COALESCE(source, 'jsonl'), model,
       SUM(input_tokens), SUM(output_tokens), SUM(total_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(cost_usd),
       SUM(n_rows), MIN(recorded_at), MAX(recorded_at)
FROM token_usage_hourly
WHERE recorded_at >= ?1 AND recorded_at < ?2 AND ` + canonicalUsageTimeOf("recorded_at") + `
GROUP BY session_id, agent_name, agent_type, team_id, board_name, COALESCE(source, 'jsonl'), model`

// RefreshTokenUsageDayAgg recomputes the dirty days that are over at now, oldest first, at most maxDays, each in its own transaction (the old
// aggregate rows of the day go, the new ones come, the mark is cleared). It returns how many days it did.
func (d *DB) RefreshTokenUsageDayAgg(ctx context.Context, now time.Time, maxDays int) (int, error) {
	current := now.UTC().Format("2006-01-02") // the day still being written is never aggregated
	done := 0
	for done < maxDays && ctx.Err() == nil {
		var day string
		if err := d.GetContext(ctx, &day, `SELECT COALESCE(MIN(day), '') FROM token_usage_day_dirty WHERE day < ?`, current); err != nil {
			return done, err
		}
		if day == "" {
			return done, nil
		}
		if err := d.refreshTokenUsageDay(ctx, day); err != nil {
			return done, err
		}
		done++
	}
	return done, ctx.Err()
}

func (d *DB) refreshTokenUsageDay(ctx context.Context, day string) error {
	tx, err := d.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM token_usage_day_agg WHERE day = ?`, day); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, refreshTokenUsageDaySQL, day, day+"~"); err != nil { // "~" sorts after every character of a timestamp
		return fmt.Errorf("aggregate token usage for %s: %w", day, err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM token_usage_day_dirty WHERE day = ?`, day); err != nil {
		return err
	}
	return tx.Commit()
}

// tokenUsageDayAggOn is false only in the tests that compare the aggregate with the hourly rows.
var tokenUsageDayAggOn = true

// hourlyBranches are the parts of usageRelation that read token_usage_hourly, from since on ("" is no lower bound). With coarse set they read
// the day aggregate where it covers whole clean days and the hourly rows elsewhere; otherwise (or when the aggregate cannot answer: not built,
// since not canonical) they are the hourly rows from since on.
//
// With coarse set and an until (#9442), the rows from until on are not read: the aggregate answers for the clean days that end at or before the day until falls in (the day itself is not whole inside the
// window), and the hourly rows of everything after the last such day are read up to until. Without an until, as before.
func hourlyBranches(ctx context.Context, db sqlGetter, since, bound string, coarse bool, until string) (parts []string, args []any) {
	untilBound := windowBound(until)
	plain := func() ([]string, []any) {
		switch {
		case since == "" && until == "" || !coarse:
			if since == "" {
				return []string{hourlyRel}, nil
			}
			return []string{hourlyRel + ` WHERE recorded_at >= ?`}, []any{bound}
		case since == "":
			return []string{hourlyRel + ` WHERE recorded_at < ?`}, []any{untilBound}
		case until == "":
			return []string{hourlyRel + ` WHERE recorded_at >= ?`}, []any{bound}
		}
		return []string{hourlyRel + ` WHERE recorded_at >= ? AND recorded_at < ?`}, []any{bound, untilBound}
	}
	if !coarse || !tokenUsageDayAggOn || (since != "" && !canonicalSince.MatchString(since)) {
		return plain()
	}
	var last string
	if err := db.GetContext(ctx, &last, `SELECT COALESCE(MAX(day), '') FROM token_usage_day_agg`); err != nil || last == "" {
		return plain()
	}
	from := "" // the first aggregated day a query may use
	if since != "" {
		t, err := time.Parse(time.RFC3339Nano, since)
		if err != nil {
			return plain()
		}
		from = t.UTC().Truncate(24 * time.Hour).Add(24 * time.Hour).Format("2006-01-02")
		if from > last {
			return plain()
		}
	}
	if until != "" { // the aggregate's days stop before the day until falls in: that day is read from its hourly rows, up to until
		var untilAt time.Time
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
			if t, err := time.Parse(layout, until); err == nil {
				untilAt = t.UTC()
				break
			}
		}
		if untilAt.IsZero() {
			return plain()
		}
		if before := untilAt.Truncate(24 * time.Hour).Add(-24 * time.Hour).Format("2006-01-02"); before < last {
			last = before
		}
		if from != "" && from > last { // no whole day of the aggregate is inside the window
			return plain()
		}
	}
	skip := `(SELECT day FROM token_usage_day_dirty UNION SELECT day FROM token_usage_day_odd)`
	parts = []string{
		`SELECT ` + usageCols + `, n_rows, day || 'T00:00:00.000Z' AS recorded_at, min_at, max_at
		 FROM token_usage_day_agg WHERE day >= ? AND day <= ? AND day NOT IN ` + skip,
	}
	args = []any{from, last}
	if since != "" { // the hourly rows of the day since falls in, from since on
		parts = append(parts, hourlyRel+` WHERE recorded_at >= ? AND recorded_at < ?`)
		args = append(args, bound, from)
	}
	// the hourly rows of the dirty and odd days inside the aggregate's range
	parts = append(parts, `SELECT `+usageCols+`, n_rows, r.recorded_at, r.recorded_at AS min_at, r.recorded_at AS max_at
		 FROM `+skip+` s JOIN token_usage_hourly r ON r.recorded_at >= s.day AND r.recorded_at < s.day || '~' WHERE s.day >= ? AND s.day <= ?`)
	args = append(args, from, last)
	// the hourly rows after the last aggregated day (up to until)
	if until != "" {
		parts = append(parts, hourlyRel+` WHERE recorded_at >= ? AND recorded_at < ?`)
		args = append(args, last+"~", untilBound)
	} else {
		parts = append(parts, hourlyRel+` WHERE recorded_at >= ?`)
		args = append(args, last+"~")
	}
	return parts, args
}

// hourlyRel is token_usage_hourly as the usage relation's columns.
const hourlyRel = `SELECT ` + usageCols + `, n_rows, recorded_at, recorded_at AS min_at, recorded_at AS max_at FROM token_usage_hourly`
