package background

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/store"
)

// #20750: a scheduled run is given the job's words and then the lines of the pictures its prompt carries.
func TestAJobRunPromptGetsItsPictureLines(t *testing.T) {
	job := store.ScheduledJob{ID: 7, Prompt: "check the table"}
	assert.Equal(t, "check the table", jobPrompt(context.Background(), job), "no hook: the words alone")
	f := func(_ context.Context, id int64) string {
		if id == 7 {
			return "\ncoral://artifacts/abc"
		}
		return ""
	}
	JobPictureLines.Store(&f)
	t.Cleanup(func() { JobPictureLines.Store(nil) })
	assert.Equal(t, "check the table\ncoral://artifacts/abc", jobPrompt(context.Background(), job))
	assert.Equal(t, "other", jobPrompt(context.Background(), store.ScheduledJob{ID: 8, Prompt: "other"}))
}
