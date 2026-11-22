package board

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
)

// ensureArtifactSavedSchema makes the table of when each file was saved for later (#20519): the time "saved" was put on it, so the Saved list orders files and messages by one clock.
func (s *Store) ensureArtifactSavedSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS artifact_saved_at (
		board_id TEXT NOT NULL,
		hex      TEXT NOT NULL,
		at       TEXT NOT NULL,
		PRIMARY KEY (board_id, hex)
	)`)
	return err
}

// noteSavedTag keeps the saved time in step with a write of the object's tags: set when "saved" is put on a file that did not have it, left alone while it keeps it, removed when it is taken off.
func noteSavedTag(ctx context.Context, tx *sqlx.Tx, boardID, hex string, had, has bool, at time.Time) error {
	switch {
	case had == has:
		return nil
	case has:
		_, err := tx.ExecContext(ctx, `INSERT INTO artifact_saved_at (board_id, hex, at) VALUES (?, ?, ?) ON CONFLICT(board_id, hex) DO UPDATE SET at = excluded.at`, boardID, hex, at.UTC().Format(time.RFC3339))
		return err
	default:
		_, err := tx.ExecContext(ctx, `DELETE FROM artifact_saved_at WHERE board_id = ? AND hex = ?`, boardID, hex)
		return err
	}
}

// ArtifactSavedAt maps each file of the board that was saved for later to when (RFC 3339, UTC). A file saved before the time was kept has none: the page falls back to the file's own time.
func (s *Store) ArtifactSavedAt(ctx context.Context, boardID string) (map[string]string, error) {
	var rows []struct {
		Hex string `db:"hex"`
		At  string `db:"at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT hex, at FROM artifact_saved_at WHERE board_id = ?`, boardID); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Hex] = r.At
	}
	return out, nil
}
