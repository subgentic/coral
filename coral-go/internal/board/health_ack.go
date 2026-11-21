package board

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/subgentic/coral/internal/clitext"
)

// Acknowledging an item of the orchestrator's check (#4175 step 3): the orchestrator marks it
// handled and it stays off the list until its state changes. Each item has a stable id (the
// check prints it) and a state (what it says now: when an escalation happened, since when an
// agent is idle, which reviews wait). The check records the state it showed; an ack copies that
// state, and the item is left out while its state is still the acknowledged one. Who may ack is
// the route's decision (Security's #4176 rule 19).

// ErrNoSuchHealthItem is an ack for an id the check has not shown on this board lately.
var ErrNoSuchHealthItem = errors.New("no such item in this board's recent health checks")

// healthItemKeep is how long an item shown once is remembered (and can be acknowledged).
const healthItemKeep = 7 * 24 * time.Hour

// NoteHealthItems records the state each item of a check has now (id -> state) and returns the
// ids whose state is the acknowledged one (left out of the check), and the ids acknowledged in
// an earlier state (back: said once, so their acknowledgement is cleared).
func (s *Store) NoteHealthItems(ctx context.Context, project string, items map[string]string, now time.Time) (acked, back map[string]bool, err error) {
	acked, back = map[string]bool{}, map[string]bool{}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	at := now.UTC().Format(healthTimeFormat)
	// When the newest check was made, even one that showed nothing: the open items are the ones shown at that time (ListOpenHealthItems).
	if _, err := tx.ExecContext(ctx, `INSERT INTO board_settings (project, key, value) VALUES (?, ?, ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value`, project, settingHealthItemsAt, at); err != nil {
		return nil, nil, err
	}
	for id, state := range items {
		if _, err := tx.ExecContext(ctx, `INSERT INTO health_items (project, item, state, shown_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(project, item) DO UPDATE SET state = excluded.state, shown_at = excluded.shown_at`, project, id, state, at); err != nil {
			return nil, nil, err
		}
		var ackedState sql.NullString
		if err := tx.GetContext(ctx, &ackedState, `SELECT acked_state FROM health_items WHERE project = ? AND item = ?`, project, id); err != nil {
			return nil, nil, err
		}
		switch {
		case !ackedState.Valid:
		case ackedState.String == state:
			acked[id] = true
		default:
			back[id] = true
			if _, err := tx.ExecContext(ctx, `UPDATE health_items SET acked_state = NULL, acked_by = NULL, acked_at = NULL WHERE project = ? AND item = ?`, project, id); err != nil {
				return nil, nil, err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM health_items WHERE project = ? AND shown_at < ?`,
		project, now.Add(-healthItemKeep).UTC().Format(healthTimeFormat)); err != nil {
		return nil, nil, err
	}
	return acked, back, tx.Commit()
}

// AckHealthItem marks an item handled in the state the check last showed it in.
func (s *Store) AckHealthItem(ctx context.Context, project, item, by string, now time.Time) error {
	res, err := s.db.ExecContext(ctx, `UPDATE health_items SET acked_state = state, acked_by = ?, acked_at = ?
		WHERE project = ? AND item = ? AND shown_at >= ?`, by, now.UTC().Format(healthTimeFormat),
		project, item, now.Add(-healthItemKeep).UTC().Format(healthTimeFormat))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNoSuchHealthItem
	}
	return nil
}

// settingHealthItemsAt is the board setting that holds when the newest check noted its items.
const settingHealthItemsAt = "health_items_at"

// maxHealthItemText bounds an item's stored line.
const maxHealthItemText = 600

// NoteHealthItemTexts stores the line each item of the check just made was shown as (id -> line), for ListOpenHealthItems. An id the check has not noted is left alone. The lines are the check's own words about
// agents' names and states, cleaned and cut here.
func (s *Store) NoteHealthItemTexts(ctx context.Context, project string, texts map[string]string) error {
	for id, text := range texts {
		t := []rune(clitext.Clean(text))
		if len(t) > maxHealthItemText {
			t = t[:maxHealthItemText]
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE health_items SET text = ? WHERE project = ? AND item = ?`, string(t), project, id); err != nil {
			return err
		}
	}
	return nil
}

// HealthItem is one open item of the last check.
type HealthItem struct {
	ID      string `db:"item" json:"id"`
	Text    string `db:"text" json:"text"`
	ShownAt string `db:"shown_at" json:"shown_at"`
}

// ListOpenHealthItems is the items the newest check of the board showed (they share its time) that are not acknowledged at the state they were shown in, oldest first by id. A check that showed nothing
// lists nothing: the time of the newest check is kept whether or not it had items.
func (s *Store) ListOpenHealthItems(ctx context.Context, project string) ([]HealthItem, error) {
	out := []HealthItem{}
	err := s.reader().SelectContext(ctx, &out, `SELECT item, text, shown_at FROM health_items
		WHERE project = ? AND shown_at = (SELECT value FROM board_settings WHERE project = ? AND key = ?) AND (acked_state IS NULL OR acked_state != state)
		ORDER BY item`, project, project, settingHealthItemsAt)
	return out, err
}
