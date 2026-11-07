package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #14133: task list --mine is the agent's own queue, in progress first.
func TestMineTasksKeepsOnlyOwnOpenTasksInProgressFirst(t *testing.T) {
	tasks := []map[string]any{
		{"id": 1.0, "status": "pending", "assigned_to": "dev", "priority": "critical"},
		{"id": 2.0, "status": "in_progress", "assigned_to": "dev", "priority": "low"},
		{"id": 3.0, "status": "in_progress", "assigned_to": "other"},
		{"id": 4.0, "status": "completed", "assigned_to": "dev"},
		{"id": 5.0, "status": "pending", "assigned_to": ""},
		{"id": 6.0, "status": "pending", "assigned_to": "dev", "priority": "low"},
		{"id": 7.0, "status": "cancelled", "assigned_to": "dev"},
	}
	var ids []float64
	for _, m := range mineTasks(tasks, "dev") {
		ids = append(ids, m["id"].(float64))
	}
	assert.Equal(t, []float64{2, 1, 6}, ids, "the in-progress one, then the waiting ones in the order given")
	assert.Empty(t, mineTasks(tasks, ""), "an unknown agent has no tasks, not the unassigned ones")
}
