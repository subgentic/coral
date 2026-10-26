// An agent's notes (the Notes panel): the type and the store methods that read and write them. Moved out of tasks.go (#8213), no code changed.

package store

import (
	"context"
	"database/sql"
	"fmt"
)

// AgentNote represents a note for an agent.
type AgentNote struct {
	ID        int64   `db:"id" json:"id"`
	AgentName string  `db:"agent_name" json:"agent_name"`
	SessionID *string `db:"session_id" json:"session_id,omitempty"`
	Content   string  `db:"content" json:"content"`
	CreatedAt string  `db:"created_at" json:"created_at"`
	UpdatedAt string  `db:"updated_at" json:"updated_at"`
}

// ListAgentNotes returns notes for an agent, optionally scoped by session.
func (s *TaskStore) ListAgentNotes(ctx context.Context, agentName string, sessionID *string) ([]AgentNote, error) {
	filter, filterArgs := sessionFilter(sessionID)
	args := append([]interface{}{agentName}, filterArgs...)
	var notes []AgentNote
	err := s.reader().SelectContext(ctx, &notes,
		`SELECT id, agent_name, content, created_at, updated_at
		 FROM agent_notes WHERE agent_name = ?`+filter+` ORDER BY created_at DESC, id DESC`,
		args...)
	return notes, err
}

// CreateAgentNote creates a new note.
func (s *TaskStore) CreateAgentNote(ctx context.Context, agentName, content string, sessionID *string) (*AgentNote, error) {
	now := nowUTC()
	result, err := s.db.ExecContext(ctx,
		`INSERT INTO agent_notes (agent_name, session_id, content, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		agentName, sessionID, content, now, now)
	if err != nil {
		return nil, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("get note insert ID: %w", err)
	}
	return &AgentNote{
		ID: id, AgentName: agentName, Content: content,
		CreatedAt: now, UpdatedAt: now,
	}, nil
}

// GetAgentNote returns a note, or nil when there is none with that id.
func (s *TaskStore) GetAgentNote(ctx context.Context, noteID int64) (*AgentNote, error) {
	var n AgentNote
	err := s.reader().GetContext(ctx, &n,
		"SELECT id, agent_name, session_id, content, created_at, updated_at FROM agent_notes WHERE id = ?", noteID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

// UpdateAgentNote updates note content.
func (s *TaskStore) UpdateAgentNote(ctx context.Context, noteID int64, content string) error {
	now := nowUTC()
	_, err := s.db.ExecContext(ctx,
		"UPDATE agent_notes SET content = ?, updated_at = ? WHERE id = ?",
		content, now, noteID)
	return err
}

// DeleteAgentNote deletes a note by ID.
func (s *TaskStore) DeleteAgentNote(ctx context.Context, noteID int64) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM agent_notes WHERE id = ?", noteID)
	return err
}

// ── Agent Events ──────────────────────────────────────────────────────

// ListNotesBySession returns notes for a historical session.
func (s *TaskStore) ListNotesBySession(ctx context.Context, sessionID string) ([]AgentNote, error) {
	var notes []AgentNote
	err := s.reader().SelectContext(ctx, &notes,
		`SELECT id, agent_name, content, created_at, updated_at
		 FROM agent_notes WHERE session_id = ? ORDER BY created_at DESC, id DESC`, sessionID)
	return notes, err
}
