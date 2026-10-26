package board

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The task list joins the workflows, so it names the task table; its updated_at must stay the same expression as the query's.
func TestPrefixedUpdatedAtSQLIsUpdatedAtSQLOnTheTaskTable(t *testing.T) {
	want := updatedAtSQL
	for _, c := range []string{"created_at", "claimed_at", "completed_at", "last_activity_at", "edited_at"} {
		want = strings.ReplaceAll(want, c, "t."+c)
	}
	assert.Equal(t, want, prefixedUpdatedAtSQL)
}
