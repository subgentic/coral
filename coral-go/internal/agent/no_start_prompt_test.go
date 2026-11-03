package agent

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// launchFileRef finds a file a launch line passes as its content: $(cat '<file>') on bash and zsh, and on PowerShell (the Windows lines) $(Get-Content -Raw -Encoding UTF8 -LiteralPath '<file>') or the shorter
// forms of it. The test read only the first, so on Windows it found no file, read nothing and failed ("" does not contain the prompt) with the code right.
var launchFileRef = regexp.MustCompile(`\$\((?:cat|Get-Content(?: -Raw)?(?: -Encoding \w+)?(?: -LiteralPath)?) '([^']+)'\)`)

// filesOf reads every file a launch line passes as such a reference: the messages and settings the CLI is started with.
func filesOf(t *testing.T, line string) string {
	t.Helper()
	var all strings.Builder
	for _, m := range launchFileRef.FindAllStringSubmatch(line, -1) {
		b, err := os.ReadFile(m[1])
		require.NoError(t, err)
		all.Write(b)
	}
	return all.String()
}

// NoStartPrompt starts a resumed CLI without the first prompt (#12358, an auto-asleep agent woken by a delivery): the launch prompt and the board's action text are in no file the line passes, for every agent
// that takes one (the board's protocol text, which an agent without a system-prompt flag is given as its first message, stays); without it the line passes the prompt.
func TestNoStartPromptLeavesOutTheFirstMessage(t *testing.T) {
	for _, typ := range []string{"claude", "codex", "gemini", "pi"} {
		t.Run(typ, func(t *testing.T) {
			ag := GetAgent(typ)
			params := LaunchParams{SessionID: "11111111-2222-3333-4444-555555555555", ResumeSessionID: "11111111-2222-3333-4444-555555555555", WorkingDir: t.TempDir(), BoardName: "team", Role: "Developer", Prompt: "UNIQUE-FIRST-PROMPT", ProtocolPath: "/nope", CLIPath: "/bin/true"}
			with, err := ag.LaunchCommand(params)
			require.NoError(t, err)
			assert.Contains(t, filesOf(t, with), "UNIQUE-FIRST-PROMPT", "a launch passes the first prompt")
			assert.Contains(t, filesOf(t, with), "Do not start any actions until you receive instructions", "and the board's action text")
			params.NoStartPrompt = true
			without, err := ag.LaunchCommand(params)
			require.NoError(t, err)
			assert.NotContains(t, filesOf(t, without), "UNIQUE-FIRST-PROMPT", "a launch asked for none passes no first prompt")
			assert.NotContains(t, filesOf(t, without), "Do not start any actions until you receive instructions", "and no action text")
		})
	}
}

// Both spellings of a file reference are found (the Windows one is what failed there, #12891).
func TestLaunchFileRefsAreFoundInBashAndPowerShellForms(t *testing.T) {
	cases := map[string]string{
		`claude --settings "$(cat '/tmp/a b/s.json')" x`:                         "/tmp/a b/s.json",
		`claude "$(Get-Content -Raw -Encoding UTF8 -LiteralPath 'D:\a\p.md')" x`: "D:\\a\\p.md",
		`x $(Get-Content -LiteralPath 'C:\t\s.json') y`:                          "C:\\t\\s.json",
		`x $(Get-Content -Raw 'C:\t\s.json') y`:                                  "C:\\t\\s.json",
	}
	for line, want := range cases {
		m := launchFileRef.FindStringSubmatch(line)
		if assert.NotNil(t, m, line) {
			assert.Equal(t, want, m[1], line)
		}
	}
	assert.Nil(t, launchFileRef.FindStringSubmatch(`echo $(date)`))
}
