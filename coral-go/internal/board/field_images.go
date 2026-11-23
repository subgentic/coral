package board

import (
	"context"
	"fmt"
	"time"
)

// Pictures on the prose fields of a record (#20731, goal #285): the Operator's words in a field of a task, a message or a file's review decision can carry up to MaxGoalImages pictures per field,
// each an artifact of the team (the route stored it and checked it). A record is told apart by its team, its kind and its own id; a field is one of the names its kind allows. Only the Operator's writes
// put them there (the routes check), a write that names a field replaces that field's set, and a field it does not name is left alone.

// Kinds of record that carry field pictures.
const (
	FieldImagesTask     = "task"     // owner: the task's number
	FieldImagesMessage  = "message"  // owner: the message's number
	FieldImagesDecision = "decision" // owner: the artifact's id (a file's review decision)
	FieldImagesJob      = "job"      // owner: a scheduled job's number; the team is "" (a person's field, #20750), field "prompt"
	FieldImagesSession  = "session"  // owner: an agent's session id; the team is "" (a person's field, #20750), field "instructions"
)

func (s *Store) ensureFieldImagesSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS board_field_images (
		board_id     TEXT NOT NULL,
		kind         TEXT NOT NULL,
		owner        TEXT NOT NULL,
		field        TEXT NOT NULL,
		pos          INTEGER NOT NULL,
		hex          TEXT NOT NULL,
		name         TEXT NOT NULL,
		content_type TEXT NOT NULL,
		PRIMARY KEY (board_id, kind, owner, field, pos)
	)`)
	return err
}

// SetFieldImages replaces the pictures of one field of a record, in the order given (at most MaxGoalImages; more are cut). An empty set clears the field.
func (s *Store) SetFieldImages(ctx context.Context, boardID, kind, owner, field string, images []GoalImage) error {
	return s.SetFieldImagesOf(ctx, boardID, kind, owner, map[string][]GoalImage{field: images})
}

// SetFieldImagesOf is SetFieldImages for several fields of one record in one transaction.
func (s *Store) SetFieldImagesOf(ctx context.Context, boardID, kind, owner string, byField map[string][]GoalImage) error {
	if len(byField) == 0 {
		return nil
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // a committed transaction has nothing to roll back
	for field, images := range byField {
		if len(images) > MaxGoalImages {
			images = images[:MaxGoalImages]
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM board_field_images WHERE board_id = ? AND kind = ? AND owner = ? AND field = ?`, boardID, kind, owner, field); err != nil {
			return err
		}
		for i, im := range images {
			if _, err := tx.ExecContext(ctx, `INSERT INTO board_field_images (board_id, kind, owner, field, pos, hex, name, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, boardID, kind, owner, field, i, im.Hex, im.Name, im.ContentType); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// FieldImages is the pictures of every field of a record, by field; nil when it has none.
func (s *Store) FieldImages(ctx context.Context, boardID, kind, owner string) (map[string][]GoalImage, error) {
	var rows []struct {
		Field string `db:"field"`
		GoalImage
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT field, hex, name, content_type FROM board_field_images WHERE board_id = ? AND kind = ? AND owner = ? ORDER BY field, pos`, boardID, kind, owner); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	out := map[string][]GoalImage{}
	for _, r := range rows {
		out[r.Field] = append(out[r.Field], r.GoalImage)
	}
	return out, nil
}

// TaskFieldImagesOwner names a task as the owner of its pictures.
func TaskFieldImagesOwner(taskID int64) string { return fmt.Sprintf("%d", taskID) }

// FieldUploadKeep is how long a picture uploaded for a field is remembered at all: past it the row is swept (the 7 days of the contract); a write can name it for the first 24 hours (the routes' fieldImageTTL).
const FieldUploadKeep = 7 * 24 * time.Hour

func (s *Store) ensureFieldUploadsSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS board_field_uploads (
		board_id TEXT NOT NULL,
		scope    TEXT NOT NULL,
		hex      TEXT NOT NULL,
		at       INTEGER NOT NULL,
		PRIMARY KEY (scope, hex)
	)`)
	return err
}

// RememberFieldUpload records that a picture was uploaded for a field scope (the team, the field and the draft, as the route names it) so a write can name it after a restart; it also sweeps the rows older than FieldUploadKeep.
// boardID is the team ("" for a person's field) and only says whose row it is.
func (s *Store) RememberFieldUpload(ctx context.Context, boardID, scope, hex string, at time.Time) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM board_field_uploads WHERE at < ?`, at.Add(-FieldUploadKeep).Unix()); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO board_field_uploads (board_id, scope, hex, at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, hex) DO UPDATE SET at = excluded.at, board_id = excluded.board_id`, boardID, scope, hex, at.Unix())
	return err
}

// FieldUploadedAt says when a picture was uploaded for a field scope; false when it never was or its row is swept.
func (s *Store) FieldUploadedAt(ctx context.Context, scope, hex string) (time.Time, bool) {
	var at int64
	if err := s.reader().GetContext(ctx, &at, `SELECT at FROM board_field_uploads WHERE scope = ? AND hex = ?`, scope, hex); err != nil {
		return time.Time{}, false
	}
	return time.Unix(at, 0), true
}

// DeleteFieldImages removes the pictures of one record (a scheduled job that is deleted, an agent whose instructions are cleared); the artifacts themselves stay (other records may share the bytes).
func (s *Store) DeleteFieldImages(ctx context.Context, boardID, kind, owner string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM board_field_images WHERE board_id = ? AND kind = ? AND owner = ?`, boardID, kind, owner)
	return err
}
