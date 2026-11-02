package store

import (
	"context"

	"github.com/jmoiron/sqlx"
)

// The person's choice to list chats Coral did not start (#11970). A brand-new Coral lists only the chats of agents it launched; the Claude Code, Codex and other
// history already on the computer waits for an explicit import.
const (
	historyImportKey = "history_import"
	// HistoryImportOn: chats found on the computer are indexed and listed. Every install that already listed them is here.
	HistoryImportOn = "1"
	// HistoryImportOff: only chats of agents Coral launched are indexed.
	HistoryImportOff = "0"
)

// UnimportedChat is a chat Coral found but did not index.
type UnimportedChat struct {
	SourceType string  `db:"source_type"`
	SourceFile string  `db:"source_file"`
	FileMtime  float64 `db:"file_mtime"`
	SessionID  string  `db:"session_id"`
}

// DecideHistoryImport returns whether found chats are indexed. Only the person's choice is ever written (Import, or Off in Settings): with none recorded, an install that already lists a chat
// Coral did not start (an index row with no agent name) keeps listing them, so nothing disappears for a current user, and a fresh one is off. A fresh Coral indexes only its own agents' chats,
// which carry their agent's name, so it stays off until the person chooses; nothing is written on the way, so a first pass leaves the settings as they were.
func (s *SessionStore) DecideHistoryImport(ctx context.Context) (bool, error) {
	settings, err := s.GetSettings(ctx)
	if err != nil {
		return false, err
	}
	if v, ok := settings[historyImportKey]; ok {
		return v == HistoryImportOn, nil
	}
	var n int
	if err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM session_index WHERE COALESCE(agent_name, '') = ''`); err != nil {
		return false, err
	}
	return n > 0, nil
}

// ImportEarlierChats records the person's choice and forgets what was held back, so the next pass reads those files and indexes them.
func (s *SessionStore) ImportEarlierChats(ctx context.Context) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO user_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, historyImportKey, HistoryImportOn); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM history_unimported`); err != nil {
		return err
	}
	return tx.Commit()
}

// NoteUnimported records chats a pass found and left out.
func (s *SessionStore) NoteUnimported(ctx context.Context, chats []UnimportedChat) error {
	if len(chats) == 0 {
		return nil
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, c := range chats {
		if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO history_unimported (source_type, source_file, file_mtime, session_id) VALUES (?, ?, ?, ?)`, c.SourceType, c.SourceFile, c.FileMtime, c.SessionID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// UnimportedMtimes is source_file -> mtime of the chats held back, for the pass to skip them like indexed ones.
func (s *SessionStore) UnimportedMtimes(ctx context.Context) (map[string]float64, error) {
	var rows []UnimportedChat
	if err := s.reader().SelectContext(ctx, &rows, `SELECT source_type, source_file, file_mtime, session_id FROM history_unimported`); err != nil {
		return nil, err
	}
	out := make(map[string]float64, len(rows))
	for _, r := range rows {
		out[r.SourceFile] = r.FileMtime
	}
	return out, nil
}

// UnimportedCounts is how many chats are held back, by CLI (source type).
func (s *SessionStore) UnimportedCounts(ctx context.Context) (map[string]int, error) {
	var rows []struct {
		SourceType string `db:"source_type"`
		N          int    `db:"n"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT source_type, COUNT(*) AS n FROM history_unimported GROUP BY source_type`); err != nil {
		return nil, err
	}
	out := make(map[string]int, len(rows))
	for _, r := range rows {
		out[r.SourceType] = r.N
	}
	return out, nil
}

// IndexedSessionIDs returns which of ids already have an index row: a chat that was listed stays listed when its agent is gone.
func (s *SessionStore) IndexedSessionIDs(ctx context.Context, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	for start := 0; start < len(ids); start += 500 {
		end := min(start+500, len(ids))
		query, args, err := sqlx.In(`SELECT session_id FROM session_index WHERE session_id IN (?)`, ids[start:end])
		if err != nil {
			return nil, err
		}
		var got []string
		if err := s.reader().SelectContext(ctx, &got, query, args...); err != nil {
			return nil, err
		}
		for _, id := range got {
			out[id] = true
		}
	}
	return out, nil
}
