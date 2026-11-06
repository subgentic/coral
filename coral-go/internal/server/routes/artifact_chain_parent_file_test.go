package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13908 (QA review, failing-first, RED at 649e23fc1): when the PARENT task has a file of its own that is still open for review, the first sibling follow-up joins it (that is the line's design) and the
// second sibling, another agent's follow-up, joins it too: the settings page becomes the next version of the series whose newest was the skill, which is the report ("a plain upload must never join a file it
// didn't name"; Needs you shows the wrong document). The fix must keep a sibling of ANOTHER uploader out of a file it did not name.
func TestASiblingFollowUpOfAnotherAgentNeverJoinsTheLinesOpenFile(t *testing.T) {
	k := newKindRig(t)
	ctx := context.Background()
	parent, err := k.h.bs.CreateTask(ctx, "alpha", "OPERATOR the draft", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	code, out := k.upTask("s1", parent.ID, "the parent's own file", "&name=parent.md")
	require.Equal(t, 201, code, out)
	skill := k.followUp("Skill", "Backend", parent.ID)
	settings := k.followUp("Settings page", "Frontend", parent.ID)
	code, out = k.upTask("s1", skill, "the skill, version one", "&name=skill.md")
	require.Equal(t, 201, code, out)
	skillSeries := out["series_id"]
	code, out = k.upTask("s2", settings, "the settings page, version one", "&name=settings.md")
	require.Equal(t, 201, code, out)
	assert.NotEqual(t, skillSeries, out["series_id"], "another agent's sibling follow-up joined the line's open file")
}
