// An agent's task list: the AgentTask type and the store methods that create, claim, update, cost and delete its tasks. Moved out of tasks.go (#8213), no code changed.

package store

import (
	"context"
	"database/sql"
	"fmt"
	"log"

	"github.com/jmoiron/sqlx"
	"github.com/subgentic/coral/internal/board"
)

// AgentTask represents a checklist item for an agent.
type AgentTask struct {
	Status            string             `db:"-" json:"status"`
	Workflow          board.TaskWorkflow `db:"-" json:"workflow"`
	BlockedBy         []board.TaskDep    `db:"-" json:"blocked_by,omitempty"`
	ID                int64              `db:"id" json:"id"`
	AgentName         string             `db:"agent_name" json:"agent_name"`
	SessionID         *string            `db:"session_id" json:"session_id,omitempty"`
	Title             string             `db:"title" json:"title"`
	Body              *string            `db:"body" json:"body,omitempty"`
	Priority          *string            `db:"priority" json:"priority,omitempty"`
	CompletionMessage *string            `db:"completion_message" json:"completion_message,omitempty"`
	Completed         int                `db:"completed" json:"completed"`
	SortOrder         int                `db:"sort_order" json:"sort_order"`
	CreatedAt         string             `db:"created_at" json:"created_at"`
	UpdatedAt         string             `db:"updated_at" json:"updated_at"`
	StartedAt         *string            `db:"started_at" json:"started_at,omitempty"`
	CompletedAt       *string            `db:"completed_at" json:"completed_at,omitempty"`
	CostUSD           float64            `db:"cost_usd" json:"cost_usd"`
	InputTokens       int                `db:"input_tokens" json:"input_tokens"`
	OutputTokens      int                `db:"output_tokens" json:"output_tokens"`
	CacheReadTokens   int                `db:"cache_read_tokens" json:"cache_read_tokens"`
	CacheWriteTokens  int                `db:"cache_write_tokens" json:"cache_write_tokens"`
	DisplayName       *string            `db:"display_name" json:"display_name,omitempty"`
}

// ListAgentTasks returns tasks for an agent, optionally scoped by session.
func (s *TaskStore) ListAgentTasks(ctx context.Context, agentName string, sessionID *string) ([]AgentTask, error) {
	filter, filterArgs := sessionFilter(sessionID)
	args := append([]interface{}{agentName}, filterArgs...)
	var tasks []AgentTask
	err := s.reader().SelectContext(ctx, &tasks,
		`SELECT id, agent_name, session_id, title, body, priority, completion_message, completed, sort_order, created_at, updated_at,
		        started_at, completed_at, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, display_name
		 FROM agent_tasks WHERE agent_name = ?`+filter+` ORDER BY sort_order`,
		args...)
	if err != nil {
		return nil, err
	}
	for i := range tasks {
		if err := s.hydrateAgentTask(ctx, &tasks[i]); err != nil {
			return nil, err
		}
	}
	return tasks, nil
}

// ListAgentTasksForSessions is ListAgentTasks for many sessions in one query (#4154): the tasks
// of each session id, in sort order and hydrated as ListAgentTasks hydrates them. A caller that
// also filters by agent name (as ListAgentTasks does) checks AgentName itself. The board status
// asked once per agent, on every poll of every board.
func (s *TaskStore) ListAgentTasksForSessions(ctx context.Context, sessionIDs []string) (map[string][]AgentTask, error) {
	out := map[string][]AgentTask{}
	if len(sessionIDs) == 0 {
		return out, nil
	}
	ids, err := sessionIDsJSON(sessionIDs)
	if err != nil {
		return nil, err
	}
	var tasks []AgentTask
	if err := s.reader().SelectContext(ctx, &tasks,
		`SELECT id, agent_name, session_id, title, body, priority, completion_message, completed, sort_order, created_at, updated_at,
		        started_at, completed_at, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, display_name
		 FROM agent_tasks WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY session_id, sort_order`, ids); err != nil {
		return nil, err
	}
	for i := range tasks {
		if err := s.hydrateAgentTask(ctx, &tasks[i]); err != nil {
			return nil, err
		}
		if tasks[i].SessionID != nil {
			out[*tasks[i].SessionID] = append(out[*tasks[i].SessionID], tasks[i])
		}
	}
	return out, nil
}

// CreateAgentTask creates a new task with auto-incrementing sort order.
// CreateAgentTask has no production caller: it is exported for the team-availability test in internal/server/routes.
func (s *TaskStore) CreateAgentTask(ctx context.Context, agentName, title string, sessionID *string, displayName *string) (*AgentTask, error) {
	return s.CreateAgentTaskWithWorkflow(ctx, agentName, title, sessionID, displayName, "", "medium", nil)
}

// GetAgentTask returns one agent task by ID, or nil.
func (s *TaskStore) GetAgentTask(ctx context.Context, taskID int64) (*AgentTask, error) {
	var t AgentTask
	err := s.reader().GetContext(ctx, &t, "SELECT * FROM agent_tasks WHERE id = ?", taskID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := s.hydrateAgentTask(ctx, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// Agent task states (the completed column): pending, done, in progress, and
// cancelled (reported as "skipped", like board tasks).
const (
	AgentTaskPending       = 0
	AgentTaskDone          = 1
	AgentTaskInProgress    = 2
	AgentTaskCancelled     = 3
	AgentTaskBlocked       = 4
	AgentTaskDraft         = 5
	AgentTaskReviewPending = 6
)

// CurrentAgentTask returns the agent's task in progress, or nil.
func (s *TaskStore) CurrentAgentTask(ctx context.Context, agentName string, sessionID *string) (*AgentTask, error) {
	filter, filterArgs := sessionFilter(sessionID)
	var t AgentTask
	err := s.db.GetContext(ctx, &t,
		"SELECT * FROM agent_tasks WHERE agent_name = ? AND completed = 2"+filter+" ORDER BY started_at DESC, id DESC LIMIT 1",
		append([]interface{}{agentName}, filterArgs...)...)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if t.Workflow.Instructions == "" {
		if err := s.hydrateAgentTask(ctx, &t); err != nil {
			return nil, err
		}
	}
	return &t, nil
}

// FinishAgentTask marks a task done or cancelled, with an optional message.
func (s *TaskStore) FinishAgentTask(ctx context.Context, taskID int64, state int, message string) error {
	return s.FinishAgentTaskWithArtifactsAndCandidate(ctx, taskID, state, message, "success", nil, "")
}

// ClaimNextAgentTask uses the shared workflow engine to claim one ready task.
// It rejects additional claims until the session's active task is finished.
func (s *TaskStore) ClaimNextAgentTask(ctx context.Context, agentName string, sessionID *string, requested ...int64) (*AgentTask, error) {
	if active, err := s.CurrentAgentTask(ctx, agentName, sessionID); err != nil {
		return nil, err
	} else if active != nil {
		return nil, fmt.Errorf("complete your current task before claiming a new one")
	}
	var task *board.Task
	var err error
	if len(requested) > 0 && requested[0] > 0 {
		own, e := s.GetAgentTask(ctx, requested[0])
		if e != nil {
			return nil, e
		}
		if own == nil || own.AgentName != agentName || sessionID != nil && (own.SessionID == nil || *own.SessionID != *sessionID) {
			return nil, fmt.Errorf("requested task is not available to this agent")
		}
	}
	task, err = s.db.TaskEngine.ClaimTask(ctx, AgentTaskProject(agentName, sessionID), agentName, requested...)
	if err != nil || task == nil {
		return nil, err
	}
	return s.GetAgentTask(ctx, task.ID)
}

// FindOpenAgentTask returns the agent's not-yet-completed task with this exact
// title (in the same session when one is given), or nil. Used to avoid a
// duplicate row when the operator creates a task and the agent then adds the
// same task to its own list (the task-sync hook posts it by title).
func (s *TaskStore) FindOpenAgentTask(ctx context.Context, agentName, title string, sessionID *string) (*AgentTask, error) {
	filter, filterArgs := sessionFilter(sessionID)
	var t AgentTask
	err := s.db.GetContext(ctx, &t,
		"SELECT * FROM agent_tasks WHERE agent_name = ? AND title = ? AND completed IN (0, 2, 4, 5)"+filter+" ORDER BY id LIMIT 1",
		append([]interface{}{agentName, title}, filterArgs...)...)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if t.Workflow.Instructions == "" {
		if err := s.hydrateAgentTask(ctx, &t); err != nil {
			return nil, err
		}
	}
	return &t, nil
}

// UpdateAgentTask updates task fields (title, completed, sort_order).
// When completed transitions to 2 (in_progress), started_at is set.
// When completed transitions to 1 (done), completed_at is set and cost is computed
// from token_usage records between started_at and completed_at.
func (s *TaskStore) UpdateAgentTask(ctx context.Context, taskID int64, title *string, completed *int, sortOrder *int) error {
	task, err := s.GetAgentTask(ctx, taskID)
	if err != nil {
		return err
	}
	if task == nil {
		return fmt.Errorf("task not found")
	}
	if title != nil {
		if _, err := s.UpdateAgentTaskWorkflow(ctx, taskID, board.TaskUpdate{Title: title}); err != nil {
			return err
		}
	}
	if completed != nil {
		switch *completed {
		case AgentTaskDone, AgentTaskCancelled:
			if err := s.FinishAgentTask(ctx, taskID, *completed, ""); err != nil {
				return err
			}
		case AgentTaskInProgress:
			if task.Completed != AgentTaskInProgress {
				if _, err := s.ClaimNextAgentTask(ctx, task.AgentName, task.SessionID, taskID); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("use a new retry task instead of resetting task status")
		}
	}
	if sortOrder != nil {
		_, err = s.db.ExecContext(ctx, "UPDATE agent_tasks SET sort_order=? WHERE id=?", *sortOrder, taskID)
	}
	return err
}

// computeAgentTaskCost sums token_usage records for the task's session
// between started_at and completed_at, and updates the task's cost fields.
func (s *TaskStore) computeAgentTaskCost(ctx context.Context, taskID int64, completedAt string) {
	// Fetch the task to get session_id and started_at
	var task struct {
		SessionID *string `db:"session_id"`
		StartedAt *string `db:"started_at"`
	}
	err := s.reader().GetContext(ctx, &task,
		"SELECT session_id, started_at FROM agent_tasks WHERE id = ?", taskID)
	if err != nil || task.SessionID == nil || task.StartedAt == nil {
		return
	}

	// Sum token_usage between started_at and completed_at for this session.
	// Use datetime() to normalize timezone suffixes (+00:00 vs Z).
	var usage struct {
		InputTokens      int     `db:"input_tokens"`
		OutputTokens     int     `db:"output_tokens"`
		CacheReadTokens  int     `db:"cache_read_tokens"`
		CacheWriteTokens int     `db:"cache_write_tokens"`
		CostUSD          float64 `db:"cost_usd"`
	}
	err = s.reader().GetContext(ctx, &usage,
		`SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
		        COALESCE(SUM(output_tokens), 0) as output_tokens,
		        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
		        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
		        COALESCE(SUM(cost_usd), 0) as cost_usd
		 FROM token_usage_all
		 WHERE session_id = ? AND datetime(recorded_at) >= datetime(?) AND datetime(recorded_at) <= datetime(?)`,
		*task.SessionID, *task.StartedAt, completedAt)
	if err != nil {
		log.Printf("[store] compute agent task cost query failed for task %d: %v", taskID, err)
		return
	}

	if _, err := s.db.ExecContext(ctx,
		`UPDATE agent_tasks SET cost_usd = ?, input_tokens = ?, output_tokens = ?,
		        cache_read_tokens = ?, cache_write_tokens = ?
		 WHERE id = ?`,
		usage.CostUSD, usage.InputTokens, usage.OutputTokens,
		usage.CacheReadTokens, usage.CacheWriteTokens, taskID); err != nil {
		log.Printf("[store] failed to update agent task cost for task %d: %v", taskID, err)
	}
}

// completeAgentTaskByTitle marks a task as completed by title match.
func (s *TaskStore) completeAgentTaskByTitle(ctx context.Context, agentName, title string, sessionID *string) error {
	task, err := s.FindOpenAgentTask(ctx, agentName, title, sessionID)
	if err != nil || task == nil {
		return err
	}
	return s.FinishAgentTask(ctx, task.ID, AgentTaskDone, "")
}

// DeleteAgentTask deletes a task by ID.
func (s *TaskStore) DeleteAgentTask(ctx context.Context, taskID int64) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	if err := tx.GetContext(ctx, &status, "SELECT status FROM board_tasks WHERE id=?", taskID); err != nil {
		return err
	}
	if status == "completed" || status == "skipped" || status == "in_progress" {
		return fmt.Errorf("only unstarted tasks can be deleted; finished results are immutable")
	}
	var incoming int
	if err := tx.GetContext(ctx, &incoming, `SELECT
 (SELECT COUNT(*) FROM task_dependencies WHERE blocked_by_task_id=?) +
 (SELECT COUNT(*) FROM task_workflows WHERE json_extract(data,'$.parent_task_id')=? OR json_extract(data,'$.retry_of')=?)`, taskID, taskID, taskID); err != nil {
		return err
	}
	if incoming > 0 {
		return fmt.Errorf("task is required by other tasks; cancel it instead")
	}
	for _, query := range []string{"DELETE FROM task_dependency_rules WHERE task_id=?", "DELETE FROM task_dependencies WHERE task_id=?", "DELETE FROM task_ready_notifications WHERE task_id=?", "DELETE FROM task_workflows WHERE task_id=?", "DELETE FROM board_tasks WHERE id=?"} {
		if _, err := tx.ExecContext(ctx, query, taskID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ReorderAgentTasks sets sort_order based on the provided ID order.
func (s *TaskStore) ReorderAgentTasks(ctx context.Context, agentName string, taskIDs []int64) error {
	now := nowUTC()
	return s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		for idx, tid := range taskIDs {
			if _, err := tx.ExecContext(ctx,
				"UPDATE agent_tasks SET sort_order = ?, updated_at = ? WHERE id = ? AND agent_name = ?",
				idx, now, tid, agentName); err != nil {
				return err
			}
		}
		return nil
	})
}

// ListTasksBySession returns tasks for a historical session.
func (s *TaskStore) ListTasksBySession(ctx context.Context, sessionID string) ([]AgentTask, error) {
	var tasks []AgentTask
	err := s.reader().SelectContext(ctx, &tasks,
		`SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY sort_order`, sessionID)
	if err != nil {
		return nil, err
	}
	for i := range tasks {
		if err := s.hydrateAgentTask(ctx, &tasks[i]); err != nil {
			return nil, err
		}
	}
	return tasks, nil
}
