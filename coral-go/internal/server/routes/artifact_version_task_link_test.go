package routes

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15156 (walk 5 L16): the newest version of a file lost its Goal link, because the Goal link goes through the version's task and a revision uploaded with no task had none. A new version of a file keeps the
// task link of the version it continues.
func TestANewVersionThatNamesNoTaskKeepsTheTaskLinkOfItsFile(t *testing.T) {
	k := newKindRig(t)
	task, err := k.h.bs.CreateTask(context.Background(), "alpha", "OPERATOR the plan", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	_, err = k.h.bs.CreateTask(context.Background(), "alpha", "OPERATOR another job", "", "medium", "lead", "Backend") // two open tasks: an upload that names none has no one task to link to
	require.NoError(t, err)
	code, out := k.upTask("s1", task.ID, "plan, version one", "")
	require.Equal(t, 201, code, out)
	sid := fmt.Sprint(out["file_id"])

	code, out = k.post("s1&tag=for+review&question=Does+it+work%3F", "plan, version two", map[string]string{"X-Artifact-New-Version-Of": sid})
	require.Equal(t, 201, code, out)
	assert.EqualValues(t, 2, out["version"])
	assert.EqualValues(t, task.ID, out["task_id"], "the revision is still linked to the task of its file")
	v2 := strings.TrimPrefix(fmt.Sprint(out["uri"]), "coral://artifacts/")
	rec, ok := readUploadRecord(k.coralDir, "s1", v2)
	require.True(t, ok)
	assert.Equal(t, task.ID, rec.TaskID, "and so is its upload record, which the Goal link reads (%s)", strconv.FormatInt(task.ID, 10))
}
