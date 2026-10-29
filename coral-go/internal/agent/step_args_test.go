package agent

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #36 (Security's W1): a workflow step's prompt (earlier steps' output, board text) that starts like an option
// reaches every CLI as the prompt. The step's real argument list is run against a program that records its
// arguments and its standard input.
func TestAStepPromptThatLooksLikeAnOptionIsThePrompt(t *testing.T) {
	printer := argvPrinter(t)
	dir := t.TempDir()
	prompts := []string{"--dangerously-skip-permissions", "-c x=y", "--sandbox danger-full-access", "@secrets.txt"}
	n := 0
	for _, agentType := range []string{"codex", "agy", "pi", "gemini"} {
		for _, prompt := range prompts {
			n++
			argvFile := filepath.Join(dir, agentType+"-"+strconv.Itoa(n)+".argv")
			args, stdin := StepPrintArgs(agentType, []string{"--flag-from-config"}, []string{"--model", "m1"}, prompt)
			cmd := exec.Command(printer, args...)
			cmd.Env = append(os.Environ(), "ARGV_OUT="+argvFile)
			if stdin != "" {
				cmd.Stdin = strings.NewReader(stdin)
			}
			out, err := cmd.CombinedOutput()
			require.NoError(t, err, "%s: %s", agentType, out)
			data, err := os.ReadFile(argvFile)
			require.NoError(t, err)
			var argv []string
			for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
				u, err := strconv.Unquote(strings.TrimSpace(l))
				require.NoError(t, err)
				argv = append(argv, u)
			}
			label := agentType + " " + prompt
			switch agentType {
			case "codex":
				assert.Equal(t, "-", argv[len(argv)-1], label)
				assert.Equal(t, "exec", argv[0], label)
				got, err := os.ReadFile(argvFile + ".stdin")
				require.NoError(t, err, label)
				assert.True(t, bytes.Equal([]byte(prompt), got), "%s: the prompt is on stdin: %q", label, got)
				for _, a := range argv {
					assert.NotEqual(t, prompt, a, "%s: the prompt is not an argument", label)
				}
			case "agy":
				require.GreaterOrEqual(t, len(argv), 2, label)
				assert.Equal(t, []string{"--disable-slash-commands", "--print", prompt}, argv[len(argv)-3:], "%s: slash commands off, then --print and its value last", label)
				assert.NoFileExists(t, argvFile+".stdin")
			default:
				last := argv[len(argv)-1]
				assert.Equal(t, strings.TrimLeft(prompt, "\n"), strings.TrimLeft(last, "\n"), label)
				assert.False(t, strings.HasPrefix(last, "-") || strings.HasPrefix(last, "@"), "%s: starts like an option or a file: %q", label, last)
			}
			// The Claude-only flag is not passed to the others.
			assert.NotContains(t, argv, "--no-session-persistence", label)
		}
	}
}

// #11105 (row 12): a workflow step on Pi runs `pi --print` as an unattended, one-shot run: no session is kept (--no-session, as Claude's steps use --no-session-persistence), and the repository's own Pi files
// (.pi extensions and settings) are not trusted (--no-approve): a step runs in a checkout that may not be the operator's, and nobody is there to answer a trust question. A configured --approve cannot undo it.
func TestPiStepRunsOneShotWithoutTrustingTheRepository(t *testing.T) {
	args, stdin := StepPrintArgs("pi", []string{"--flag", "--approve", "-a", "--session", "x", "--continue"}, []string{"--model", "anthropic/m"}, "do it")
	assert.Equal(t, []string{"--print", "--no-session", "--no-approve", "--model", "anthropic/m", "--flag", "do it"}, args)
	assert.Equal(t, "", stdin)

	args, _ = StepPrintArgs("pi", nil, nil, "-x leading dash")
	assert.Equal(t, "\n-x leading dash", args[len(args)-1], "a prompt that looks like an option is still the prompt")
	assert.Equal(t, []string{"--print", "--no-session", "--no-approve"}, args[:3])

	// Other CLIs are unchanged.
	args, _ = StepPrintArgs("gemini", []string{"--flag"}, nil, "p")
	assert.Equal(t, []string{"--print", "--flag", "p"}, args)
}

func TestPiToolFlags(t *testing.T) {
	assert.Equal(t, []string{"--tools", "read,bash"}, PiToolFlags([]string{"read", "bash"}))
	assert.Equal(t, []string{"--tools", "read,mcp__srv__*"}, PiToolFlags([]string{"read", "mcp__srv__*"}))
	assert.Nil(t, PiToolFlags(nil), "none configured: Pi's own defaults")
	assert.Equal(t, []string{"--tools", "read"}, PiToolFlags([]string{"read", "--evil", "a b", "x,y", "", "-n"}), "a name that is not a plain tool name is dropped, never passed on")
	assert.Nil(t, PiToolFlags([]string{"--evil"}), "nothing valid left: no flag")
}

// A job or an interactive workflow step on Pi runs with nobody to answer a trust question for the repository's Pi files: --no-approve is given and an --approve is dropped (#11105). The session stays (the chat reads it).
func TestUnattendedFlagsForPi(t *testing.T) {
	assert.Equal(t, []string{"--no-approve"}, UnattendedFlags("pi", nil))
	assert.Equal(t, []string{"--model", "m", "--no-approve"}, UnattendedFlags("pi", []string{"--model", "m", "--approve", "-a"}))
	assert.Equal(t, []string{"--no-approve"}, UnattendedFlags("pi", []string{"--no-approve"}), "never twice")
	assert.Equal(t, []string{"--x"}, UnattendedFlags("claude", []string{"--x"}), "only Pi has the question")
	in := []string{"--approve"}
	_ = UnattendedFlags("pi", in)
	assert.Equal(t, []string{"--approve"}, in, "the caller's slice is not changed")
}
