package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// --force on task reassign (#14862): assign past the team's limit of waiting tasks; without it the request carries no force.
func TestTaskReassignTakesForce(t *testing.T) {
	to, force, err := parseReassign([]string{"--to", "Dev A", "--force"})
	require.NoError(t, err)
	assert.Equal(t, "Dev A", to)
	assert.True(t, force)
	to, force, err = parseReassign([]string{"--to", "Dev B"})
	require.NoError(t, err)
	assert.Equal(t, "Dev B", to)
	assert.False(t, force)
	got, err := parseReassignAssignee([]string{"--to", "Dev C", "--force"})
	require.NoError(t, err)
	assert.Equal(t, "Dev C", got, "the older parser still answers the assignee")
	_, _, err = parseReassign([]string{"Dev A"})
	assert.Error(t, err, "a bare name is still refused: --to names the assignee")
}
