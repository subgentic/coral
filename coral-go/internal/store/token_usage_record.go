// Recording token usage: one row or a batch in a transaction, with the prepared insert and the repricing of rows recorded without a cost. Moved out of token_usage.go (#8296), no code changed.

package store

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

// RepriceZeroCosts fills historical usage rows whose model is now recognized.
// Older pollers stored zero when a provider-specific model alias was unknown.
func (s *TokenUsageStore) RepriceZeroCosts(ctx context.Context, price func(model string, input, output, cacheRead, cacheWrite int) float64) error {
	rows, err := s.db.QueryContext(ctx, `SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM token_usage WHERE cost_usd = 0 AND model IS NOT NULL AND model <> ''`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type row struct {
		id   int64
		cost float64
	}
	var updates []row
	for rows.Next() {
		var id int64
		var model string
		var in, out, read, write int
		if err := rows.Scan(&id, &model, &in, &out, &read, &write); err != nil {
			return err
		}
		cost := price(model, in, out, read, write)
		if cost > 0 {
			updates = append(updates, row{id, cost})
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, u := range updates {
		if _, err := s.db.ExecContext(ctx, `UPDATE token_usage SET cost_usd = ? WHERE id = ? AND cost_usd = 0`, u.cost, u.id); err != nil {
			return err
		}
	}
	return nil
}

// RecordUsage inserts a per-call token usage record. Each row represents a
// single API call's delta tokens at a specific timestamp. The composite key
// (session_id, recorded_at) ensures one row per call — duplicates are ignored.
func (s *TokenUsageStore) RecordUsage(ctx context.Context, u *TokenUsage) error {
	return s.recordUsageOn(ctx, s.db, u)
}

// usageExecer is what a record is written through: the database (one statement at a time, each its own
// transaction) or a transaction (RecordUsageBatch).
type usageExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// usageBatchMax is the most records RecordUsageBatch writes in one transaction: the database has one
// writer, and a first scan of a long transcript has thousands of calls, which should not hold it for all of them.
const usageBatchMax = 500

// RecordUsageBatch records each of us as RecordUsage does (the same statements, the same duplicate and
// timestamp rules, the thinking breakdown only for a call that was stored), many to a transaction instead
// of one: on a first read of a long transcript the transaction per call was most of the token poller's time
// (#5074). The result is one error per record, nil for one that was recorded or ignored as a repeat; a record
// that fails does not stop the others. If a transaction cannot begin or commit, its records all carry that error.
func (s *TokenUsageStore) RecordUsageBatch(ctx context.Context, us []*TokenUsage) []error {
	errs := make([]error, len(us))
	for lo := 0; lo < len(us); lo += usageBatchMax {
		hi := min(lo+usageBatchMax, len(us))
		tx, err := s.db.BeginTxx(ctx, nil)
		if err != nil {
			for i := lo; i < hi; i++ {
				errs[i] = err
			}
			continue
		}
		ex := &preparedExecer{tx: tx}
		for i := lo; i < hi; i++ {
			errs[i] = s.recordUsageOn(ctx, ex, us[i])
		}
		ex.close()
		if err := tx.Commit(); err != nil {
			_ = tx.Rollback()
			for i := lo; i < hi; i++ {
				errs[i] = err
			}
		}
	}
	return errs
}

// preparedExecer runs a transaction's statements prepared once each: a batch repeats the same two statements for every
// record, and parsing them again each time was a large part of the cost of a record.
type preparedExecer struct {
	tx    *sqlx.Tx
	stmts map[string]*sql.Stmt
}

func (p *preparedExecer) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	st, ok := p.stmts[query]
	if !ok {
		var err error
		if st, err = p.tx.PrepareContext(ctx, query); err != nil {
			return nil, err
		}
		if p.stmts == nil {
			p.stmts = map[string]*sql.Stmt{}
		}
		p.stmts[query] = st
	}
	return st.ExecContext(ctx, args...)
}

func (p *preparedExecer) close() {
	for _, st := range p.stmts {
		_ = st.Close()
	}
}

func (s *TokenUsageStore) recordUsageOn(ctx context.Context, ex usageExecer, u *TokenUsage) error {
	stamped := u.RecordedAt == ""
	if stamped {
		u.RecordedAt = tokenUsageNow()
	}
	if u.AgentType == "" {
		u.AgentType = "claude"
	}

	if u.Source == "" {
		u.Source = "jsonl"
	}

	insert := func() (sql.Result, error) {
		return ex.ExecContext(ctx,
			`INSERT OR IGNORE INTO token_usage
		 (session_id, agent_name, agent_type, team_id, board_name, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, num_turns, session_start_at, last_activity_at, recorded_at, source, model, thinking)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''),
		   COALESCE(NULLIF(?, ''), CASE WHEN ? THEN (SELECT NULLIF(LOWER(TRIM(thinking)), '') FROM live_sessions WHERE session_id = ?) END))`,
			u.SessionID, u.AgentName, u.AgentType, u.TeamID, u.BoardName,
			u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheWriteTokens, u.TotalTokens, u.CostUSD, u.NumTurns, u.SessionStartAt, u.LastActivityAt, u.RecordedAt, u.Source, strings.TrimSpace(u.Model),
			strings.ToLower(strings.TrimSpace(u.Thinking)), liveCall(u.RecordedAt), u.SessionID)
	}
	result, err := insert()
	if err != nil {
		return err
	}
	// (session_id, recorded_at) drops a second report of the same transcript turn. A row Coral
	// stamped itself (a report with no timestamp) that lands on the same instant as another of
	// its session is not a duplicate: it takes the next free microsecond rather than being
	// dropped (#3920: on Windows' coarser clock two reports in a row collided).
	for i := 0; stamped && i < 1000; i++ {
		if n, _ := result.RowsAffected(); n > 0 {
			break
		}
		next, perr := time.Parse(ISOFormat, u.RecordedAt)
		if perr != nil {
			break
		}
		u.RecordedAt = next.Add(time.Microsecond).Format(ISOFormat)
		if result, err = insert(); err != nil {
			return err
		}
	}
	id, err := result.LastInsertId()
	if err != nil {
		return err
	}
	u.ID = id
	if n, _ := result.RowsAffected(); n > 0 {
		return s.recordThinking(ctx, ex, u) // only a call that was stored counts: a repeated report is ignored
	}
	return nil
}

// liveCallWindow is how recent a call's own timestamp must be for the session's current thinking level to be taken as the level it ran at (#8915). The level of a session can change, and a first read of a
// long transcript records calls from days ago: those keep what the transcript said, or nothing (never a guess).
const liveCallWindow = 15 * time.Minute

// liveCall reports whether a call recorded at recordedAt (an RFC 3339 time) happened just now.
func liveCall(recordedAt string) bool {
	t, err := time.Parse(ISOFormat, recordedAt)
	if err != nil {
		if t, err = time.Parse(time.RFC3339Nano, recordedAt); err != nil {
			return false
		}
	}
	age := time.Since(t)
	return age >= -liveCallWindow && age <= liveCallWindow
}
