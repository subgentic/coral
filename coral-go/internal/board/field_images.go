package board

import (
	"context"
	"fmt"
)

// Pictures on the prose fields of a record (#20731, goal #285): the Operator's words in a field of a task, a message or a file's review decision can carry up to MaxGoalImages pictures per field,
// each an artifact of the team (the route stored it and checked it). A record is told apart by its team, its kind and its own id; a field is one of the names its kind allows. Only the Operator's writes
// put them there (the routes check), a write that names a field replaces that field's set, and a field it does not name is left alone.

// Kinds of record that carry field pictures.
const (
	FieldImagesTask     = "task"     // owner: the task's number
	FieldImagesMessage  = "message"  // owner: the message's number
	FieldImagesDecision = "decision" // owner: the artifact's id (a file's review decision)
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
