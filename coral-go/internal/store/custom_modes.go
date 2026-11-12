package store

import (
	"context"
	"encoding/json"
	"time"
)

// CustomMode is one custom permission mode as stored (#15950). The caller validates the set (custommodes.ValidateSet) before it is stored and checks each row again after it is read.
type CustomMode struct {
	ID        string
	AgentType string
	Name      string
	Flags     []string
}

type customModeRow struct {
	ID        string `db:"id"`
	AgentType string `db:"agent_type"`
	Name      string `db:"name"`
	Flags     string `db:"flags"`
}

// ListCustomModes is every custom mode, in the order the set was saved.
func (s *SessionStore) ListCustomModes(ctx context.Context) ([]CustomMode, error) {
	var rows []customModeRow
	if err := s.reader().SelectContext(ctx, &rows, `SELECT id, agent_type, name, flags FROM custom_modes ORDER BY position, id`); err != nil {
		return nil, err
	}
	out := make([]CustomMode, 0, len(rows))
	for _, r := range rows {
		flags := []string{}
		if json.Unmarshal([]byte(r.Flags), &flags) != nil || flags == nil {
			flags = []string{} // unreadable: no flags, which the caller's check refuses
		}
		out = append(out, CustomMode{ID: r.ID, AgentType: r.AgentType, Name: r.Name, Flags: flags})
	}
	return out, nil
}

// ReplaceCustomModes stores modes as the whole set and one log row (how many, and how many of them turn the prompts off), in one transaction.
func (s *SessionStore) ReplaceCustomModes(ctx context.Context, modes []CustomMode, bypass int) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM custom_modes`); err != nil {
		return err
	}
	for i, m := range modes {
		flags, err := json.Marshal(append([]string{}, m.Flags...))
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO custom_modes (id, agent_type, name, flags, position) VALUES (?, ?, ?, ?, ?)`, m.ID, m.AgentType, m.Name, string(flags), i); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO custom_modes_log (at, modes, bypass) VALUES (?, ?, ?)`, time.Now().UTC().Format(time.RFC3339), len(modes), bypass); err != nil {
		return err
	}
	return tx.Commit()
}
