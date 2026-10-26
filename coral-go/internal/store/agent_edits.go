// The files an agent's edit events touched: the ToolCount type and the store methods that read them. Moved out of tasks.go (#8213), no code changed.

package store

import (
	"context"
	"path/filepath"

	"github.com/jmoiron/sqlx"
)

// ToolCount holds a tool name and its usage count.
type ToolCount struct {
	ToolName string `db:"tool_name" json:"tool_name"`
	Count    int    `db:"count" json:"count"`
}

// GetFileEdits returns a map of relative file paths to the agents that edited them,
// derived from Write/Edit tool_use events in agent_events.
// The workingDir is used to convert absolute paths in detail_json to repo-relative paths.
func (s *TaskStore) GetFileEdits(ctx context.Context, sessionID, workingDir string) (map[string][]FileAgent, error) {
	var rows []struct {
		AgentName    string `db:"agent_name"`
		FilePath     string `db:"file_path"`
		LastEditedAt string `db:"last_edited_at"`
	}
	err := s.reader().SelectContext(ctx, &rows,
		`SELECT agent_name,
		        json_extract(detail_json, '$.file_path') as file_path,
		        MAX(created_at) as last_edited_at
		 FROM agent_events
		 WHERE session_id = ?
		   AND event_type = 'tool_use'
		   AND tool_name IN ('Write', 'Edit')
		   AND detail_json IS NOT NULL
		 GROUP BY agent_name, json_extract(detail_json, '$.file_path')`,
		sessionID)
	if err != nil {
		return nil, err
	}

	result := make(map[string][]FileAgent, len(rows))
	for _, r := range rows {
		if r.FilePath == "" {
			continue
		}
		// Convert absolute path to repo-relative
		relPath := r.FilePath
		if workingDir != "" && filepath.IsAbs(relPath) {
			if rel, err := filepath.Rel(workingDir, relPath); err == nil {
				relPath = rel
			}
		}
		result[relPath] = append(result[relPath], FileAgent{
			Name:         r.AgentName,
			LastEditedAt: r.LastEditedAt,
		})
	}
	return result, nil
}

// GetAllEditedFileCounts returns the count of distinct files each session has
// edited via Write/Edit tool events. Used for the tooltip file count display.
// GetAllEditedFileCounts has no production caller: it is exported for the session-list performance test in internal/server/routes.
func (s *TaskStore) GetAllEditedFileCounts(ctx context.Context) (map[string]int, error) {
	var rows []struct {
		SessionID string `db:"session_id"`
		Count     int    `db:"cnt"`
	}
	err := s.reader().SelectContext(ctx, &rows,
		`SELECT session_id, COUNT(*) AS cnt FROM agent_event_files GROUP BY session_id`) // edited_files.go
	if err != nil {
		return nil, err
	}
	result := make(map[string]int, len(rows))
	for _, r := range rows {
		result[r.SessionID] = r.Count
	}
	return result, nil
}

// getEditedFilesBySession returns the set of absolute file paths each session has
// touched via Write/Edit tool events. Used by the git poller to build per-agent
// file counts instead of sharing repo-wide git diff results across all agents.
func (s *TaskStore) getEditedFilesBySession(ctx context.Context, sessionIDs []string) (map[string]map[string]bool, error) {
	if len(sessionIDs) == 0 {
		return map[string]map[string]bool{}, nil
	}

	query, args, err := sqlx.In(
		`SELECT session_id,
		        json_extract(detail_json, '$.file_path') as file_path
		 FROM agent_events INDEXED BY idx_agent_events_edited_files
		 WHERE session_id IN (?)
		   AND event_type = 'tool_use'
		   AND tool_name IN ('Write', 'Edit')
		   AND detail_json IS NOT NULL AND json_valid(detail_json)`,
		sessionIDs)
	if err != nil {
		return nil, err
	}
	query = s.db.Rebind(query)

	var rows []struct {
		SessionID string `db:"session_id"`
		FilePath  string `db:"file_path"`
	}
	if err := s.reader().SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}

	result := make(map[string]map[string]bool, len(sessionIDs))
	for _, r := range rows {
		if r.FilePath == "" {
			continue
		}
		if result[r.SessionID] == nil {
			result[r.SessionID] = make(map[string]bool)
		}
		result[r.SessionID][r.FilePath] = true
	}
	return result, nil
}

// ── History queries (by session_id only) ────────────────────────────────
