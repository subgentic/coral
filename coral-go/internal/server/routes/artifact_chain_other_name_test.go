package routes

import (
	"context"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15155 (walk 5 M8, #15159): an agent uploaded README.md and then index.html for the same task; the server's own join of a task's line made index.html 'version 1 of 8' in README's series, with README's file id.
// The task line keeps one open file per NAME: another name is another file with its own series, and each name's next upload is its own next version.
func TestAnotherFileOfTheSameTaskIsNotAVersionOfTheLinesOpenFile(t *testing.T) {
	k := newKindRig(t)
	task, err := k.h.bs.CreateTask(context.Background(), "alpha", "OPERATOR the site", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	up := func(name, body string) (int, map[string]any) {
		return k.post("s1&tag=for+review&question=Does+it+work%3F", body, map[string]string{"X-Artifact-Task": strconv.FormatInt(task.ID, 10), "X-Artifact-Name": name})
	}
	code, out := up("README.md", "the readme")
	require.Equal(t, 201, code, out)
	code, out = up("index.html", "the page")
	require.Equal(t, 201, code, out)
	assert.Nil(t, out["series_id"], "index.html joined README's series")
	assert.NotEqualValues(t, 2, out["version"], "index.html is not README's version 2")

	code, out = up("README.md", "the readme, revised")
	require.Equal(t, 201, code, out)
	assert.NotNil(t, out["series_id"], "the same name still joins its own file, even with another file of the task uploaded in between")
	assert.EqualValues(t, 2, out["version"])
}
