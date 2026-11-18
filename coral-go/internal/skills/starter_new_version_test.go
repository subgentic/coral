package skills

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Operator (rc4 preview): the tour's agent re-uploaded the reviewed sample report as a second, unlinked file, so the viewer showed neither v1's comments nor the version bar (a file in no series has neither). A changed file is
// uploaded with --new-version-of, and both tours say so (#18634).
func TestTheGettingStartedSkillsUploadAChangedFileAsANewVersion(t *testing.T) {
	for _, name := range []string{"getting-started-agent", "getting-started-team"} {
		b, err := starterFS.ReadFile("starter/" + name + "/SKILL.md")
		require.NoError(t, err)
		assert.Contains(t, string(b), "--new-version-of <digest of the earlier upload>", name)
		assert.Contains(t, string(b), "never as a separate file", name)
	}
}

// An orchestrator that wants a fresh agent restarts the one on the board; it never launches a second one for the same job (#19508).
func TestOrchestratorSkillTeachesManagingAgentsAlreadyOnTheBoard(t *testing.T) {
	md := StarterText("orchestrator-team-builder")
	require.NotEmpty(t, md)
	for _, want := range []string{"## 7. Managing agents already on the board", "`coral-board restart \"<agent>\"`", "`coral-board sleep \"<agent>\"`", "`coral-board wake \"<agent>\"`", "never replaced by a new launch", "the server's words"} {
		require.Contains(t, md, want)
	}
}
