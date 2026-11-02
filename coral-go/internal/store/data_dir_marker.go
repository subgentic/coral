package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// dataDirIDKey is the store_meta row that ties this database to the data folder that made it (internal/dataowner, task #429).
const dataDirIDKey = "data_dir_id"

// DataDirID returns the id stored in the database, "" when there is none.
func (d *DB) DataDirID(ctx context.Context) (string, error) {
	var v string
	err := d.GetContext(ctx, &v, `SELECT value FROM store_meta WHERE key = ?`, dataDirIDKey)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetDataDirID stores the id, replacing any other.
func (d *DB) SetDataDirID(ctx context.Context, id string) error {
	_, err := d.ExecContext(ctx, `INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, dataDirIDKey, id)
	return err
}

// ActiveSessionCount is how many live sessions the database lists (the ones a start could wake or recover).
func (d *DB) ActiveSessionCount(ctx context.Context) (int, error) {
	var n int
	err := d.GetContext(ctx, &n, `SELECT COUNT(*) FROM live_sessions WHERE status = 'active'`)
	return n, err
}

// HasUserSettings reports whether the database holds a user_settings row (a sign that the install was used: internal/dataowner's second proof of an old install).
func (d *DB) HasUserSettings(ctx context.Context) (bool, error) {
	var n int
	err := d.GetContext(ctx, &n, `SELECT EXISTS(SELECT 1 FROM user_settings)`)
	return n == 1, err
}

// OldestActiveSession is when the oldest active live session was created; false when there is none. A created_at that cannot be read as a time is ignored.
func (d *DB) OldestActiveSession(ctx context.Context) (time.Time, bool, error) {
	var rows []string
	if err := d.SelectContext(ctx, &rows, `SELECT created_at FROM live_sessions WHERE status = 'active'`); err != nil {
		return time.Time{}, false, err
	}
	var oldest time.Time
	found := false
	for _, r := range rows {
		for _, layout := range []string{ISOFormat, time.RFC3339Nano, "2006-01-02 15:04:05"} {
			if at, err := time.Parse(layout, r); err == nil {
				if !found || at.Before(oldest) {
					oldest, found = at, true
				}
				break
			}
		}
	}
	return oldest, found, nil
}
