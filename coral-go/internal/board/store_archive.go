package board

import (
	"context"
	"encoding/json"
	"time"
)

// A team is archived (#21850) when its board carries the "archived" setting: the Operator put it away, and it leaves the sidebar, the Inbox and the pickers, until Restore team.
// Nothing is deleted. The flag is stored as the pause is, in board_settings, so it needs no table; Remove team deletes it with the rest of the board's settings.
const settingArchived = "archived"

// settingArchivedAt is when the team was archived (RFC 3339, UTC): the Teams page says "Archived 24 Nov".
const settingArchivedAt = "archived_at"

// settingArchivedAgents lists (a JSON array of session ids) the agents Archive team archived: Restore team unarchives only those, so an agent the Operator archived on its own stays archived (#21915).
const settingArchivedAgents = "archived_agents"

// notArchivedSQL keeps only the rows of boards that are not archived: the all-boards goal and task reads leave an archived team out (#21850). A team's own page still reads its board whole.
const notArchivedSQL = `board_id NOT IN (SELECT project FROM board_settings WHERE key = 'archived' AND value = 'true')`

// SetBoardArchived stores whether a board is archived, and when. Restoring forgets the time.
func (s *Store) SetBoardArchived(ctx context.Context, project string, archived bool) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM board_settings WHERE project = ? AND key IN (?, ?, ?)`, project, settingArchived, settingArchivedAt, settingArchivedAgents); err != nil {
		return err
	}
	if archived {
		if _, err := tx.ExecContext(ctx, `INSERT INTO board_settings (project, key, value) VALUES (?, ?, 'true')`, project, settingArchived); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO board_settings (project, key, value) VALUES (?, ?, ?)`, project, settingArchivedAt, time.Now().UTC().Format(time.RFC3339)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// BoardArchived reports whether a board is archived.
func (s *Store) BoardArchived(ctx context.Context, project string) bool {
	var v string
	if err := s.db.GetContext(ctx, &v, `SELECT value FROM board_settings WHERE project = ? AND key = ?`, project, settingArchived); err != nil {
		return false
	}
	return v == "true"
}

// ArchivedBoards maps each archived board to when it was archived ("" for one archived before the time was kept).
func (s *Store) ArchivedBoards(ctx context.Context) (map[string]string, error) {
	var rows []struct {
		Project string `db:"project"`
		At      string `db:"at"`
	}
	err := s.reader().SelectContext(ctx, &rows, `SELECT a.project AS project, COALESCE(t.value, '') AS at FROM board_settings a
		LEFT JOIN board_settings t ON t.project = a.project AND t.key = ?
		WHERE a.key = ? AND a.value = 'true'`, settingArchivedAt, settingArchived)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Project] = r.At
	}
	return out, nil
}

// SetBoardArchivedAgents records the agents Archive team archived (the team's own set: an agent already archived is not in it).
func (s *Store) SetBoardArchivedAgents(ctx context.Context, project string, ids []string) error {
	raw, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO board_settings (project, key, value) VALUES (?, ?, ?) ON CONFLICT(project, key) DO UPDATE SET value = excluded.value`, project, settingArchivedAgents, string(raw))
	return err
}

// BoardArchivedAgents returns the agents Archive team archived, nil when none were recorded.
func (s *Store) BoardArchivedAgents(ctx context.Context, project string) []string {
	var v string
	if err := s.db.GetContext(ctx, &v, `SELECT value FROM board_settings WHERE project = ? AND key = ?`, project, settingArchivedAgents); err != nil {
		return nil
	}
	var ids []string
	if json.Unmarshal([]byte(v), &ids) != nil {
		return nil
	}
	return ids
}
