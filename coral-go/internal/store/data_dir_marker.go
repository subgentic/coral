package store

import (
	"context"
	"database/sql"
	"errors"
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
