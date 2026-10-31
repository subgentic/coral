package board

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/jmoiron/sqlx"
	"strings"
)

// WorkingMode is the team convention, frozen into a task on its first claim.
type WorkingMode struct {
	Mode               string `json:"mode"`
	DependencyGuidance bool   `json:"dependency_guidance"`
	CustomInstructions string `json:"custom_instructions"`
	// AsksAreTasks adds the work-on-tasks rule to the instructions every task of the team is claimed with (goal #21): asks for work go through tasks, plain posts are for talk. Off when absent (a team keeps today's instructions until it turns it on).
	AsksAreTasks bool   `json:"asks_are_tasks"`
	Instructions string `json:"instructions"`
}

// AsksAreTasksRule is the sentence the setting adds.
const AsksAreTasksRule = "Ask another agent for work with coral-board post --assign or task add --follow-up; plain posts are for questions, decisions, heads-ups and status."

// ReviewTagRule is the sentence every task is claimed with (#11424), added at the claim to the team working instructions (not part of a team's saved mode, so Settings and the mode API show only what the team chose): what makes a file the person's to look at, and what does not, so Needs you holds the first and not the second. The docs, the upload help and the
// default prompts say the same.
const ReviewTagRule = `If the Operator needs to see, decide or approve an artifact, tag it "for review". If it is for other agents or for yourself (logs, patches, notes, screenshots for a reviewer), do not tag it for review.`

func (m *WorkingMode) normalize() error {
	if m.Mode == "" {
		m.Mode = "none"
	}
	m.CustomInstructions = strings.TrimSpace(m.CustomInstructions)
	if len(m.CustomInstructions) > 4096 {
		return fmt.Errorf("custom instructions must be at most 4096 bytes")
	}
	if m.DependencyGuidance {
		m.Instructions = joinModeInstruction(m.Instructions, "Connect stages as separate dependent tasks with explicit prerequisites and named required outputs.")
	}
	if m.AsksAreTasks {
		m.Instructions = joinModeInstruction(m.Instructions, AsksAreTasksRule)
	}
	m.Instructions = joinModeInstruction(m.Instructions, m.CustomInstructions)
	return nil
}
func joinModeInstruction(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	return a + "\n" + b
}

func loadWorkingMode(ctx context.Context, db sqlx.QueryerContext, project string) (WorkingMode, error) {
	m := WorkingMode{Mode: "none"}
	var data string
	err := sqlx.GetContext(ctx, db, &data, "SELECT data FROM board_working_modes WHERE board_id = ?", project)
	if err == sql.ErrNoRows {
		err = nil
		data = `{}`
	}
	if err != nil {
		return m, err
	}
	if err = json.Unmarshal([]byte(data), &m); err != nil {
		return m, err
	}
	// Resolve current preset guidance; claim snapshots remain immutable.
	preset, err := loadWorkflowPreset(ctx, db, project, m.Mode)
	if err != nil {
		return m, err
	}
	m.Instructions = preset.Instructions
	err = m.normalize()
	return m, err
}
func (s *Store) GetWorkingMode(ctx context.Context, project string) (WorkingMode, error) {
	return loadWorkingMode(ctx, s.reader(), project)
}
func (s *Store) SetWorkingMode(ctx context.Context, project string, m WorkingMode) (WorkingMode, error) {
	preset, err := loadWorkflowPreset(ctx, s.db, project, m.Mode)
	if err != nil {
		return m, err
	}
	m.Instructions = preset.Instructions
	if err := m.normalize(); err != nil {
		return m, err
	}
	data, err := json.Marshal(m)
	if err != nil {
		return m, err
	}
	_, err = s.db.ExecContext(ctx, "INSERT INTO board_working_modes(board_id,data) VALUES(?,?) ON CONFLICT(board_id) DO UPDATE SET data=excluded.data", project, string(data))
	return m, err
}
