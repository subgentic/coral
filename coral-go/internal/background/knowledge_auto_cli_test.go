//go:build !windows

package background

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agentsignin"
	at "github.com/subgentic/coral/internal/agenttypes"
)

// #13928 (Security's MUST 3): the call of an automatic run holds no authority. A fake CLI notes how it was run.

const fakeCLI = `#!/bin/sh
{
  echo "ARGS:"
  for a in "$@"; do echo "[$a]"; done
  echo "PWD:$(pwd)"
  echo "CORAL_TOKEN:${CORAL_TOKEN:-unset}"
  echo "CORAL_SESSION:${CORAL_SESSION_ID:-unset}"
  echo "GITHUB_TOKEN:${GITHUB_TOKEN:-unset}"
  echo "AWS_SECRET_ACCESS_KEY:${AWS_SECRET_ACCESS_KEY:-unset}"
  echo "ANTHROPIC_API_KEY:${ANTHROPIC_API_KEY:-unset}"
  echo "STDIN:"
  cat
} > "$FAKE_NOTES"
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then echo "the codex answer" > "$a"; fi
  prev="$a"
done
echo "the answer"
`

func fakeCLIAt(t *testing.T, script string) (path, notes string) {
	t.Helper()
	dir := t.TempDir()
	path = filepath.Join(dir, "fakecli")
	require.NoError(t, os.WriteFile(path, []byte(script), 0o755))
	return path, filepath.Join(dir, "notes.txt")
}

func runFake(t *testing.T, agentType, model string) (answer, notes string) {
	t.Helper()
	path, notesPath := fakeCLIAt(t, fakeCLI)
	t.Setenv("CORAL_TOKEN", "board-token")
	t.Setenv("CORAL_SESSION_ID", "sess")
	t.Setenv("GITHUB_TOKEN", "gh")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "aws")
	t.Setenv("ANTHROPIC_API_KEY", "the-clis-own-key")
	c := &AutoCLI{AgentType: agentType, Path: path, Model: model, Timeout: 20 * time.Second,
		signIn: func(context.Context) error { return nil }, extraEnv: []string{"FAKE_NOTES=" + notesPath}}
	out, err := c.Call(context.Background(), "SYSTEM PROMPT", "TRANSCRIPT TEXT")
	require.NoError(t, err)
	b, err := os.ReadFile(notesPath)
	require.NoError(t, err)
	return out, string(b)
}

func TestClaudeIsRunWithNoToolsNoSettingsNoSecretsAndTheTextOnStdin(t *testing.T) {
	out, notes := runFake(t, at.Claude, "claude-sonnet-5-5")
	assert.Equal(t, "the answer", out)
	for _, want := range []string{"[--print]", "[--no-session-persistence]", "[--tools]\n[]", "[--disable-slash-commands]", "[--strict-mcp-config]", "[--setting-sources]\n[project]", "[--model]\n[claude-sonnet-5-5]"} {
		assert.Contains(t, notes, want)
	}
	assert.NotContains(t, notes, "SYSTEM PROMPT\n[", "the prompt is not an argument")
	args := notes[:strings.Index(notes, "PWD:")]
	assert.NotContains(t, args, "SYSTEM PROMPT")
	assert.NotContains(t, args, "TRANSCRIPT TEXT")
	assert.Contains(t, notes, "STDIN:\nSYSTEM PROMPT")
	assert.Contains(t, notes, "TRANSCRIPT TEXT")
	assert.Contains(t, notes, "CORAL_TOKEN:unset")
	assert.Contains(t, notes, "CORAL_SESSION:unset")
	assert.Contains(t, notes, "GITHUB_TOKEN:unset", "a token that is not the CLI's own sign-in is removed")
	assert.Contains(t, notes, "AWS_SECRET_ACCESS_KEY:unset", "so is any variable not on the allowlist")
	assert.Contains(t, notes, "ANTHROPIC_API_KEY:the-clis-own-key", "the CLI's own sign-in stays")
	pwd := strings.TrimSpace(strings.Split(strings.Split(notes, "PWD:")[1], "\n")[0])
	assert.Contains(t, pwd, "coral-knowledge-", "it ran in an empty temp folder")
	_, err := os.Stat(pwd)
	assert.True(t, os.IsNotExist(err), "which is removed afterwards")
}

func TestCodexIsRunReadOnlyEphemeralWithItsConfigIgnoredAndTheTextOnStdin(t *testing.T) {
	out, notes := runFake(t, at.Codex, "gpt-5.5-codex")
	assert.Equal(t, "the codex answer", out, "the last message file is the answer")
	for _, want := range []string{"[exec]", "[--ephemeral]", "[--skip-git-repo-check]", "[--sandbox]\n[read-only]", "[--ignore-user-config]", "[--ignore-rules]", "[--output-last-message]", "[--model]\n[gpt-5.5-codex]"} {
		assert.Contains(t, notes, want)
	}
	args := notes[:strings.Index(notes, "PWD:")]
	// A literal list, not codexOffFeatures: a name taken out of the code's list must fail here (QA's SHOULD on #13928).
	for _, feature := range []string{"shell_tool", "unified_exec", "hooks", "apps", "plugins", "browser_use", "browser_use_external", "computer_use", "image_generation", "view_image"} {
		assert.Contains(t, args, "[--disable]\n["+feature+"]", "Codex's %s is switched off", feature)
	}
	assert.Equal(t, 10, strings.Count(args, "[--disable]"), "no switch is dropped, none is added unreviewed")
	assert.Contains(t, args, "[--disable]\n[shell_tool]")
	assert.True(t, strings.HasSuffix(strings.TrimSpace(args), "[-]"), "the prompt comes from stdin: %s", args)
	assert.NotContains(t, args, "SYSTEM PROMPT")
	assert.NotContains(t, args, "danger")
	assert.Contains(t, notes, "STDIN:\nSYSTEM PROMPT")
	assert.Contains(t, notes, "CORAL_TOKEN:unset")
}

func TestAModelThatCouldBeAFlagIsNotPassed(t *testing.T) {
	_, notes := runFake(t, at.Claude, "--dangerously-skip-permissions")
	assert.NotContains(t, notes, "dangerously")
	assert.NotContains(t, notes, "[--model]")
	_, notes = runFake(t, at.Claude, "")
	assert.NotContains(t, notes, "[--model]", "no Workers default set: the CLI's own")
}

func TestSignedOutMeansNoCallAndTheCLIIsNeverRun(t *testing.T) {
	path, notes := fakeCLIAt(t, fakeCLI)
	c := &AutoCLI{AgentType: at.Claude, Path: path, Timeout: time.Second,
		signIn:   func(context.Context) error { return &agentsignin.NotSignedInError{Agent: at.Claude} },
		extraEnv: []string{"FAKE_NOTES=" + notes}}
	_, err := c.Call(context.Background(), "p", "c")
	assert.ErrorIs(t, err, ErrAutoNotSignedIn)
	_, statErr := os.Stat(notes)
	assert.True(t, os.IsNotExist(statErr), "the CLI was not started")
}

func TestAFailingCLIsWordsAreNotKeptAndATimeoutIsSaid(t *testing.T) {
	path, _ := fakeCLIAt(t, "#!/bin/sh\necho 'SECRET-IN-OUTPUT'\nexit 3\n")
	c := &AutoCLI{AgentType: at.Claude, Path: path, Timeout: 5 * time.Second, signIn: func(context.Context) error { return nil }}
	_, err := c.Call(context.Background(), "p", "c")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "SECRET")
	slow, _ := fakeCLIAt(t, "#!/bin/sh\nsleep 5\n")
	c = &AutoCLI{AgentType: at.Claude, Path: slow, Timeout: 200 * time.Millisecond, signIn: func(context.Context) error { return nil }}
	_, err = c.Call(context.Background(), "p", "c")
	assert.ErrorIs(t, err, ErrAutoTimedOut)
}

func TestTheEnvironmentOfTheCallIsAnAllowlist(t *testing.T) {
	got := authorityFreeEnv([]string{"PATH=/bin", "CORAL_URL=http://x", "CORAL_SESSION_TOKEN=t", "GH_TOKEN=g", "AWS_SECRET_ACCESS_KEY=s", "AWS_ACCESS_KEY_ID=k", "DATABASE_URL=postgres://x", "MY_API_KEY=k",
		"ANTHROPIC_API_KEY=a", "CLAUDE_CODE_OAUTH_TOKEN=o", "CLAUDE_CONFIG_DIR=/c", "OPENAI_API_KEY=oa", "CODEX_HOME=/h2", "HOME=/h", "LC_ALL=C", "https_proxy=http://p", "SSH_AUTH_SOCK=/s", "coral_lower=1", "SomethingNew=1"})
	assert.ElementsMatch(t, []string{"PATH=/bin", "ANTHROPIC_API_KEY=a", "CLAUDE_CODE_OAUTH_TOKEN=o", "CLAUDE_CONFIG_DIR=/c", "OPENAI_API_KEY=oa", "CODEX_HOME=/h2", "HOME=/h", "LC_ALL=C", "https_proxy=http://p"}, got)
}

func TestOnlyClaudeAndCodexCanDistill(t *testing.T) {
	_, err := NewAutoCLI(context.Background(), map[string]string{}, at.Gemini)
	assert.ErrorIs(t, err, ErrAutoCLIMissing)
	assert.Equal(t, []string{at.Claude, at.Codex}, AutoKnowledgeAgentTypes())
	assert.Equal(t, "claude-opus-5-5", workersModel(map[string]string{"default_model_claude": "claude-opus-5-5"}, at.Claude))
	assert.Equal(t, "", workersModel(map[string]string{"default_model_claude": "a b"}, at.Claude))
}
