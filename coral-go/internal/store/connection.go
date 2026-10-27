// Package store provides the SQLite storage layer for Coral.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/dbcrypt"
	"github.com/subgentic/coral/internal/testguard"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite"
)

// DB wraps an sqlx.DB with schema management and migration support.
type DB struct {
	*sqlx.DB
	readDB     *sqlx.DB
	TaskEngine *board.Store

	callMetricsInit sync.Once
	callMetrics     *callMetricBuffer

	// tokenOwners caches SessionTokenOwnerOf (#4303); see session_tokens.go.
	tokenOwners tokenOwnerCache
	proofKeys   proofKeySet
}

// Reader returns the read-only connection pool, or the primary connection
// if no separate read pool exists (such as for in-memory databases).
func (d *DB) Reader() *sqlx.DB {
	if d.readDB != nil {
		return d.readDB
	}
	return d.DB
}

// ReaderStats returns database stats for the read-only connection pool.
func (d *DB) ReaderStats() sql.DBStats {
	return d.Reader().Stats()
}

// Close writes queued request metrics, then closes the database and read pool.
func (d *DB) Close() error {
	d.closeCallMetrics()
	var firstErr error
	if d.readDB != nil && d.readDB != d.DB {
		if err := d.readDB.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if err := d.DB.Close(); err != nil && firstErr == nil {
		firstErr = err
	}
	return firstErr
}

// OpenWithKey opens a plaintext database when key is empty, or a SQLCipher
// database when key is present. The caller must resolve the key before this
// function is called so no startup path can silently fall back to plaintext.
func OpenWithKey(ctx context.Context, dbPath, key string) (*DB, error) {
	return openWithDriver(ctx, dbPath, key, false)
}

// OpenPrepared opens a plaintext sessions database file that is a copy of one this build already migrated (storetest makes it): the schema step is not run again. It is for
// tests, which open hundreds of databases: parsing the whole schema each time was a large part of a heavy test's CPU. A file that is not a copy of this build's migrated
// database must not be opened with it.
func OpenPrepared(ctx context.Context, dbPath string) (*DB, error) {
	return openWithDriver(ctx, dbPath, "", true)
}

func openWithDriver(ctx context.Context, dbPath, key string, schemaDone bool) (*DB, error) {
	testguard.CheckDataPath(dbPath)
	if key == "" {
		if err := dbcrypt.RejectEncryptedFile(dbPath); err != nil {
			return nil, err
		}
	}
	if key != "" {
		// Fail before touching the filesystem: a standard build has no
		// SQLCipher driver and must not create or open anything with a key.
		if err := dbcrypt.RequireAvailable(); err != nil {
			return nil, err
		}
	}
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create db directory: %w", err)
	}

	driver := "sqlite"
	dsn := dbPath + "?_pragma=busy_timeout(30000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)&_pragma=temp_store(MEMORY)&_pragma=cache_size(-8000)" + journalSizeLimitParam
	if key != "" {
		// The SQLCipher driver's own DSN keys: it ignores _pragma_ ones (#3454).
		driver = dbcrypt.EncryptedDriver
		dsn = dbcrypt.EncryptedDSN(dbPath, key, dbcrypt.DSNOptions{ForeignKeys: true})
	}
	db, err := sqlx.Open(driver, dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	// SQLite should use a single connection to avoid locking issues.
	db.SetMaxOpenConns(1)

	d := &DB{
		DB: db,
	}

	if !schemaDone {
		if err := d.ensureSchema(ctx); err != nil {
			db.Close()
			return nil, fmt.Errorf("ensure schema: %w", err)
		}
	}
	scrubRemoteURLCredentials(ctx, d)
	if err := d.initAgentTaskEngine(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize personal task workflows: %w", err)
	}
	if key != "" {
		reportForeignKeyOrphans(ctx, dbPath, key)
	}

	if isInMemoryPath(dbPath) {
		d.readDB = db
	} else {
		readDSN := dbPath + "?_pragma=busy_timeout(30000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)&_pragma=temp_store(MEMORY)&_pragma=cache_size(-8000)&_pragma=query_only(1)"
		if key != "" {
			readDSN = dbcrypt.EncryptedDSN(dbPath, key, dbcrypt.DSNOptions{ReadOnly: true, ForeignKeys: true})
		}
		readDB, err := sqlx.Open(driver, readDSN)
		if err != nil {
			d.Close()
			return nil, fmt.Errorf("open read database: %w", err)
		}
		readDB.SetMaxOpenConns(4)
		readDB.SetMaxIdleConns(4)
		d.readDB = readDB
	}

	return d, nil
}

func isInMemoryPath(dbPath string) bool {
	if dbPath == "" || dbPath == ":memory:" {
		return true
	}
	if strings.Contains(dbPath, ":memory:") {
		return true
	}
	if strings.HasPrefix(dbPath, "file:") && strings.Contains(dbPath, "mode=memory") {
		return true
	}
	return false
}

// ensureSchema creates all tables, indexes, and runs migrations.
func (d *DB) ensureSchema(ctx context.Context) error {
	// Create all tables
	if _, err := d.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}

	// Run column migrations (ignore errors for already-existing columns)
	for _, m := range columnMigrations {
		sql := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", m.table, m.column, m.definition)
		d.ExecContext(ctx, sql) // Ignore error — column may already exist
	}

	// When a person opened a run (#9315): the column is added here, not in columnMigrations, because the runs that are over when it is added are all given the time: nobody is told about a history
	// they never saw (a run finished after this is unread until it is opened). ALTER succeeds only when the column is new, so the backfill runs once.
	for _, table := range []string{"scheduled_runs", "workflow_runs"} {
		if _, err := d.ExecContext(ctx, "ALTER TABLE "+table+" ADD COLUMN seen_at TEXT"); err == nil {
			d.ExecContext(ctx, "UPDATE "+table+" SET seen_at = ? WHERE status NOT IN ('running', 'pending')", time.Now().UTC().Format(ISOFormat))
		}
	}

	// A board bookmark belongs to its board's team (#4792); an agent's takes the team it was saved with.
	d.ExecContext(ctx, `UPDATE saved_messages SET team = ref WHERE kind = 'board' AND team = ''`)

	// Archived implies sleeping. A Coral older than is_archived can wake an
	// archived agent without clearing the flag; restore the invariant on open.
	d.ExecContext(ctx, `UPDATE live_sessions SET is_archived = 0 WHERE is_archived = 1 AND is_sleeping = 0`)

	// A tag's colour is #rgb, #rrggbb or #rrggbbaa (#4875): a row stored before that was checked is given the default colour, so that no client of
	// the API (the dashboard checks on read; Coral Hub's own pages may not) gets a colour that is CSS. Only the colour value changes.
	if n, err := d.ResetInvalidTagColors(ctx); err != nil {
		slog.Warn("could not check the tag colours", "error", err)
	} else if n > 0 {
		slog.Warn("tag colours that were not hex colours were reset to the default", "tags", n)
	}

	// Indexes on migrated columns cannot live in schemaSQL: on an older
	// database the column does not exist yet when schemaSQL runs.
	d.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_agent_events_ref
		ON agent_events(session_id, event_type, ref_id) WHERE ref_id IS NOT NULL`)

	// The (session_id, created_at) and (session_id, event_type, created_at)
	// indexes in schemaSQL cover these prefixes; the rowid that SQLite appends
	// to every index entry lets "latest per session" queries seek backwards
	// instead of sorting the history.
	d.ExecContext(ctx, `DROP INDEX IF EXISTS idx_agent_events_session`)
	d.ExecContext(ctx, `DROP INDEX IF EXISTS idx_agent_events_session_type`)
	// Pre-release name of idx_agent_events_edited_files, without json_valid.
	d.ExecContext(ctx, `DROP INDEX IF EXISTS idx_agent_events_file_edits`)
	// Nothing filters call_metrics by agent or board (the summary reads a
	// created_at range), and these two were ~550 MB on a busy server and made
	// every insert update three indexes instead of one (#3261).
	d.ExecContext(ctx, `DROP INDEX IF EXISTS idx_call_metrics_agent`)
	d.ExecContext(ctx, `DROP INDEX IF EXISTS idx_call_metrics_board`)

	// Indexes on migrated columns cannot live in schemaSQL (see above).
	// sourceDedup's NOT IN subquery reads every jsonl session id.
	d.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage(source, session_id)`)
	if err := d.ensureTokenUsageRollup(ctx); err != nil {
		return err
	}
	if err := d.ensureTokenUsageHourAgg(ctx); err != nil {
		return err
	}
	if err := d.ensureTokenUsageDayAgg(ctx); err != nil {
		return err
	}
	if err := d.ensureTokenUsageThinkingModel(ctx); err != nil {
		return err
	}

	// Fix double-encoded detail_json rows in agent_events (one-time fixup).
	// Prior to the fix, makeToolDetail returned a JSON string which was then
	// re-marshaled, producing '"{\"key\":\"val\"}"' instead of '{"key":"val"}'.
	// It reads every event, so it runs once (#4129: ~450 ms on 200k events, cold, on every
	// start, growing with the history): a store_meta row marks it done.
	fixDoubleEncodedDetailJSON(ctx, d)

	// After the fixup above, so a new table is filled from the fixed rows (#3846).
	if err := d.ensureEditedFiles(ctx); err != nil {
		return err
	}
	return nil
}

// journalSizeLimitParam: the writer's WAL is truncated back to JournalSizeLimit after a
// checkpoint (#4142).
var journalSizeLimitParam = fmt.Sprintf("&_pragma=journal_size_limit(%d)", JournalSizeLimit)
