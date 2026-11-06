package skills

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCLILinesReadsCodeBlocksAndInlineCommandsAndDropsComments(t *testing.T) {
	md := "Use `coral-board sleep \"<agent>\"` now.\n\n```sh\ncoral-board status --json          # the \"board\" line\nPROMPT=$(cat <<'P'\nYou are Reviewer.\nP\n)\ncoral-agent launch /path/to/folder --name \"R\" --prompt \"$PROMPT\" --board <board id>\n```\nAdd `--type T` or `--model M`.\n"
	assert.Equal(t, []string{"coral-board status --json", `coral-agent launch /path/to/folder --name "R" --prompt "$PROMPT" --board <board id>`}, CLILines(md)[1:], "code blocks")
	assert.Equal(t, `coral-board sleep "<agent>"`, CLILines(md)[0], "an inline command")
	assert.Equal(t, []string{"--type", "--model"}, FlagSpans(md))
	assert.Equal(t, []string{"launch", "/d", "--name", "R Q", "--prompt", "x", "--board", "x"}, RunnableArgs(`coral-agent launch /path/to/folder --name "R Q" --prompt "$PROMPT" --board <board id>`, "/d"))
}

func TestTheTeamBuilderSkillShowsCommands(t *testing.T) {
	md := StarterText(TeamBuilderName)
	require.NotEmpty(t, md)
	assert.GreaterOrEqual(t, len(CLILines(md)), 5, "the launch, the upload, the wait and the status lines are all read")
}
