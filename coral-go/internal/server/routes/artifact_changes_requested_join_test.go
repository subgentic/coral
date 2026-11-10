package routes

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #15115 (walk 3, N1): after Request changes the agent's revised file was a new file ('version 1', 'Comments 0'), the earlier thread out of reach. An upload with no open task (none, two, a finished one) never
// joined its file's series, and nothing else linked it. A revision of a file the Operator asked changes on, by its own uploader, with the same name, is the file's next version.
func (k *kindRig) requestChanges(out map[string]any) {
	k.t.Helper()
	id := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	_, _, err := k.h.bs.DecideArtifactReview(context.Background(), "alpha", id, board.ReviewChangesRequested, time.Now())
	require.NoError(k.t, err)
}

func (k *kindRig) upNamed(session, name, content string) (int, map[string]any) {
	k.t.Helper()
	return k.post(session+"&tag=for+review&question=Does+it+work%3F", content, map[string]string{"X-Artifact-Task": "none", "X-Artifact-Name": name})
}

func TestARevisionOfAFileTheOperatorAskedChangesOnIsItsNextVersionWithNoTask(t *testing.T) {
	k := newKindRig(t)
	code, out := k.upNamed("s1", "README.md", "the readme, draft")
	require.Equal(t, 201, code, out)
	first := out["uri"].(string)
	k.requestChanges(out)

	code, out = k.upNamed("s1", "README.md", "the readme, revised")
	require.Equal(t, 201, code, out)
	assert.EqualValues(t, 2, out["version"], "the revision is version 2 of the same file, not a new 'version 1'")
	assert.NotNil(t, out["series_id"])
	assert.NotEqual(t, first, out["uri"])
}

func TestARevisionJoinsOnlyTheSameUploadersFileOfTheSameName(t *testing.T) {
	k := newKindRig(t)
	code, out := k.upNamed("s1", "README.md", "the readme, draft")
	require.Equal(t, 201, code, out)
	k.requestChanges(out)

	code, out = k.upNamed("s1", "NOTES.md", "another file")
	require.Equal(t, 201, code, out)
	assert.Nil(t, out["series_id"], "another name is another file")
	code, out = k.upNamed("s2", "README.md", "another agent's readme")
	require.Equal(t, 201, code, out)
	assert.Nil(t, out["series_id"], "another agent's file is never joined by a plain upload")
}

func TestAFileTheOperatorDecidedIsNotJoinedByAnUploadOfTheSameName(t *testing.T) {
	k := newKindRig(t)
	code, out := k.upNamed("s1", "README.md", "the readme, draft")
	require.Equal(t, 201, code, out)
	id := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	_, _, err := k.h.bs.DecideArtifactReview(context.Background(), "alpha", id, board.ReviewApproved, time.Now())
	require.NoError(t, err)
	code, out = k.upNamed("s1", "README.md", "a new readme")
	require.Equal(t, 201, code, out)
	assert.Nil(t, out["series_id"], "an approved file is done: a new upload is a new file")
}
