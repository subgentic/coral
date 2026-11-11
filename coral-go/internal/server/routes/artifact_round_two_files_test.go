package routes

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15338 (walk 23 H1): README.md and app.js uploaded in one round for one task shared one version chain (the same file id), so app.js 'replaced' README and README left Needs you as 'superseded' and could
// not be approved. Two names are two files: each stays waiting for review, and only a newer version of the SAME name closes the older one.
func TestTwoFilesOfOneRoundBothStayWaitingAndOnlyTheSameNameSupersedes(t *testing.T) {
	k := newKindRig(t)
	task, err := k.h.bs.CreateTask(context.Background(), "alpha", "OPERATOR the site", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	up := func(name, body string) map[string]any {
		code, out := k.post("s1&tag=for+review&question=Does+it+work%3F", body, map[string]string{"X-Artifact-Task": strconv.FormatInt(task.ID, 10), "X-Artifact-Name": name})
		require.Equal(t, 201, code, out)
		return out
	}
	id := func(out map[string]any) string { return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/") }
	tagsOf := func(out map[string]any) []string {
		all, err := k.h.bs.ArtifactTags(context.Background(), "alpha")
		require.NoError(t, err)
		return all[id(out)]
	}

	readme := up("README.md", "the readme")
	app := up("app.js", "the app")
	assert.Nil(t, app["series_id"], "app.js joined README's chain")
	assert.Contains(t, tagsOf(readme), "for review", "README is still waiting for review")
	assert.NotContains(t, tagsOf(readme), "superseded", "README was closed by app.js")
	assert.Contains(t, tagsOf(app), "for review")

	app2 := up("app.js", "the app, revised")
	assert.EqualValues(t, 2, app2["version"], "app.js's next upload is its own version 2")
	assert.Contains(t, tagsOf(app), "superseded", "the older app.js is replaced by the newer one")
	assert.Contains(t, tagsOf(readme), "for review", "README is untouched by a new app.js")
	assert.NotContains(t, tagsOf(readme), "superseded")
	assert.Contains(t, tagsOf(app2), "for review")
}
