package board

import (
	"context"
	"strings"
)

// Pictures on a goal (#11650, goal #184): the Operator's description of a goal can carry up to MaxGoalImages pictures, each an artifact of the goal's team (the route stores it and checks its type); the goal keeps their ids,
// names and types in the order sent. They are the Operator's and never an agent's: only the goal route's create writes them, after it checked the Operator uploaded each a moment ago.

// MaxGoalImages is the most pictures a goal carries.
const MaxGoalImages = 4

// GoalImage is one picture of a goal.
type GoalImage struct {
	Hex         string `db:"hex" json:"hex"`
	Name        string `db:"name" json:"name"`
	ContentType string `db:"content_type" json:"content_type"`
}

func (s *Store) ensureGoalImagesSchema(ctx context.Context) error {
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS board_goal_images (
			board_id     TEXT NOT NULL,
			goal_id      INTEGER NOT NULL,
			pos          INTEGER NOT NULL,
			hex          TEXT NOT NULL,
			name         TEXT NOT NULL,
			content_type TEXT NOT NULL,
			PRIMARY KEY (board_id, goal_id, pos)
		)`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// SetGoalImages records the pictures of a goal in the order given (at most MaxGoalImages; more are cut), replacing any it had.
func (s *Store) SetGoalImages(ctx context.Context, boardID string, goalID int64, images []GoalImage) error {
	if len(images) > MaxGoalImages {
		images = images[:MaxGoalImages]
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // a committed transaction has nothing to roll back
	if _, err := tx.ExecContext(ctx, `DELETE FROM board_goal_images WHERE board_id = ? AND goal_id = ?`, boardID, goalID); err != nil {
		return err
	}
	for i, im := range images {
		if _, err := tx.ExecContext(ctx, `INSERT INTO board_goal_images (board_id, goal_id, pos, hex, name, content_type) VALUES (?, ?, ?, ?, ?, ?)`, boardID, goalID, i, im.Hex, im.Name, im.ContentType); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// fillGoalImages gives each goal its pictures. A goal is told apart by its board and id.
func (s *Store) fillGoalImages(ctx context.Context, goals []Goal) error {
	if len(goals) == 0 {
		return nil
	}
	ids := make([]any, len(goals))
	for i := range goals {
		ids[i] = goals[i].ID
	}
	var rows []struct {
		BoardID string `db:"board_id"`
		GoalID  int64  `db:"goal_id"`
		GoalImage
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT board_id, goal_id, hex, name, content_type FROM board_goal_images WHERE goal_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+`) ORDER BY board_id, goal_id, pos`, ids...); err != nil {
		return err
	}
	type key struct {
		board string
		id    int64
	}
	by := map[key][]GoalImage{}
	for _, r := range rows {
		k := key{r.BoardID, r.GoalID}
		by[k] = append(by[k], r.GoalImage)
	}
	for i := range goals {
		goals[i].Images = by[key{goals[i].BoardID, goals[i].ID}]
	}
	return nil
}
