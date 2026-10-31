package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// passwordLines are the two lines the pane's shell is given for a password file: the server's own variable read from the file, and a second variable set from the first. The line is the shell's (detectShell): `export`
// and `$(cat ...)` for a POSIX shell, `$env:` and Get-Content for PowerShell, which is what a Windows pane has.
func passwordLines(file string) (read, copied string) {
	if detectShell() == ShellPowerShell {
		return "$env:OPENCODE_SERVER_PASSWORD = (Get-Content -Raw -LiteralPath '" + file + "').Trim()", "$env:OPENCODE_PASSWORD = $env:OPENCODE_SERVER_PASSWORD"
	}
	return `export OPENCODE_SERVER_PASSWORD="$(cat '` + file + `')"`, `export OPENCODE_PASSWORD="$OPENCODE_SERVER_PASSWORD"`
}

// #11364: the opencode TUI is attached to Coral's own server, resumes by its own session id, and gets the server's password from a private file, never in the line.
func TestOpencodeLaunchAttachesToCoralsServerAndNeverPutsThePasswordInTheLine(t *testing.T) {
	cmd, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{
		SessionID: "11111111-2222-3333-4444-555555555555", SessionName: "opencode-11111111-2222-3333-4444-555555555555",
		OpencodeURL: "http://127.0.0.1:4711", OpencodePasswordFile: "/data/opencode/password",
		ResumeSessionID: "ses_abc123_DEF-9",
	})
	require.NoError(t, err)
	assert.Contains(t, cmd, "--server http://127.0.0.1:4711")
	assert.Contains(t, cmd, "--session ses_abc123_DEF-9")
	read, copied := passwordLines("/data/opencode/password")
	assert.Contains(t, cmd, read, "read from the private file by the pane's shell")
	assert.Contains(t, cmd, copied, "a build whose version is not said gets both variables")
	assert.NotContains(t, cmd, "--standalone", "never the person's own or a private server of its own")
	assert.Contains(t, cmd, "opencode --server")
}

func TestOpencodeLaunchIgnoresAResumeIdThatIsNotASessionIdAndDropsFlagsThatAimElsewhere(t *testing.T) {
	for _, id := range []string{"abc", "ses_", "ses_a b", "ses_a;rm -rf /", "ses_$(x)", "--session", "../ses_x", "11111111-2222-3333-4444-555555555555"} {
		cmd, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{OpencodeURL: "http://127.0.0.1:1", ResumeSessionID: id})
		require.NoError(t, err)
		assert.NotContains(t, cmd, "--session", "%q starts a fresh session", id)
		assert.NotContains(t, cmd, id, "%q is not in the line", id)
		assert.False(t, IsResumeID(at.Opencode, id), id)
	}
	assert.True(t, IsResumeID(at.Opencode, "ses_abc123"))
	cmd, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{OpencodeURL: "http://127.0.0.1:1", Flags: []string{"--server", "http://evil:1", "--session=ses_other", "-s", "ses_x", "--standalone", "--password", "pw", "--keep-me"}})
	require.NoError(t, err)
	assert.Equal(t, 1, strings.Count(cmd, "--server"), "only Coral's own")
	for _, bad := range []string{"evil", "ses_other", "ses_x", "--standalone", "--password", "pw"} {
		assert.NotContains(t, cmd, bad)
	}
	assert.Contains(t, cmd, "--keep-me")
}

func TestOpencodeLaunchNeedsCoralsServer(t *testing.T) {
	_, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{})
	assert.ErrorContains(t, err, "not running")
	assert.Equal(t, at.Opencode, GetAgent(at.Opencode).AgentType())
	assert.True(t, GetAgent(at.Opencode).SupportsResume())
}

// The sign-in line puts opencode's credentials where the agents' servers keep theirs (their XDG folders), and quotes every value: a folder with a space or a quote in it cannot change the line.
func TestTheOpencodeLoginCommandSignsInInTheAgentServersFolderAndQuotesEveryValue(t *testing.T) {
	cmd := OpencodeLoginCommand("", [][2]string{{"XDG_DATA_HOME", "/Users/a b/it's/opencode/data"}, {"XDG_CONFIG_HOME", "/c"}})
	assert.Contains(t, cmd, "XDG_DATA_HOME=")
	assert.Contains(t, cmd, "XDG_CONFIG_HOME=")
	assert.True(t, strings.HasSuffix(cmd, "opencode auth login"), cmd)
	assert.NotContains(t, cmd, "/Users/a b/it's/opencode/data ", "the value is quoted, not bare")
	assert.Equal(t, 1, strings.Count(cmd, "auth login"))
	assert.Contains(t, OpencodeLoginCommand("/opt/o c/opencode", nil), "auth login")
	assert.Contains(t, OpencodeLoginCommand("/opt/o c/opencode", nil), "'/opt/o c/opencode'", "the CLI the settings name is quoted too")
}

// #137997: the public opencode (1.x) is attached with `opencode attach <url> -s <session>` and reads its password from OPENCODE_SERVER_PASSWORD; 2.x with `opencode --server <url> --session <id>` and OPENCODE_PASSWORD.
func TestOpencode1xIsAttachedWithTheSubcommandAndItsOwnPasswordVariable(t *testing.T) {
	cmd, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{
		SessionID: "11111111-2222-3333-4444-555555555555", SessionName: "opencode-11111111-2222-3333-4444-555555555555",
		OpencodeURL: "http://127.0.0.1:4711", OpencodePasswordFile: "/data/opencode/password", OpencodeMajor: 1,
		ResumeSessionID: "ses_abc123_DEF-9",
		Flags:           []string{"--model", "openai/gpt-6", "-p", "hunter2", "--password=hunter3", "-u", "me", "--print-logs"},
	})
	require.NoError(t, err)
	assert.Contains(t, cmd, "opencode attach http://127.0.0.1:4711")
	assert.Contains(t, cmd, "-s ses_abc123_DEF-9")
	assert.NotContains(t, cmd, "--server")
	assert.NotContains(t, cmd, "--session")
	read, _ := passwordLines("/data/opencode/password")
	assert.Contains(t, cmd, read, "the variable 1.x reads, from the private file")
	assert.NotContains(t, cmd, "OPENCODE_PASSWORD", "1.x does not read it")
	for _, secret := range []string{"hunter2", "hunter3", " -p ", "--password"} {
		assert.NotContains(t, cmd, secret, "no password on any command line, and a person's own is dropped")
	}
	assert.NotContains(t, cmd, "--model", "attach has no --model: the model is the server's config")
	assert.NotContains(t, cmd, "gpt-6")
	assert.Contains(t, cmd, "--print-logs", "a flag attach has stays")
}

func TestOpencode2xIsAttachedWithServerAndBothPasswordVariables(t *testing.T) {
	cmd, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{
		OpencodeURL: "http://127.0.0.1:4711", OpencodePasswordFile: "/data/opencode/password", OpencodeMajor: 2,
		ResumeSessionID: "ses_abc123", Flags: []string{"--model", "openai/gpt-6"},
	})
	require.NoError(t, err)
	assert.Contains(t, cmd, "opencode --server http://127.0.0.1:4711")
	assert.Contains(t, cmd, "--session ses_abc123")
	assert.NotContains(t, cmd, "attach")
	read, copied := passwordLines("/data/opencode/password")
	assert.Contains(t, cmd, read)
	assert.Contains(t, cmd, copied)
	assert.Contains(t, cmd, "--model openai/gpt-6", "2.x's TUI takes it")

	again, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{OpencodeURL: "http://127.0.0.1:4711", OpencodeMajor: 0})
	require.NoError(t, err)
	assert.Contains(t, again, "--server", "not said: the form this adapter was first written for")
}

func TestTheAttachLineTakesNoSessionThatIsNotOne(t *testing.T) {
	for _, id := range []string{"abc", "ses_a b", "ses_a;rm -rf /", "ses_$(x)", "-s", "../ses_x", ""} {
		cmd, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{OpencodeURL: "http://127.0.0.1:1", OpencodeMajor: 1, ResumeSessionID: id})
		require.NoError(t, err)
		assert.NotContains(t, cmd, " -s ", "%q", id)
		assert.NotContains(t, cmd, id+"'", "%q", id)
	}
}

// 1.x's attach runs in the folder it is given: without --dir the agent's tools worked in Coral's own opencode data folder (the end-to-end run, #137997). The folder is one argument, quoted.
func TestOpencode1xIsAttachedInTheAgentsOwnFolder(t *testing.T) {
	cmd, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{OpencodeURL: "http://127.0.0.1:4711", OpencodeMajor: 1, WorkingDir: "/Users/a b/it's here"})
	require.NoError(t, err)
	assert.Contains(t, cmd, "--dir ")
	assert.Contains(t, cmd, "it", "the folder is on the line")
	assert.NotContains(t, cmd, "--dir /Users/a b/", "a folder with a space is quoted, not bare")
	none, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{OpencodeURL: "http://127.0.0.1:4711", OpencodeMajor: 1})
	require.NoError(t, err)
	assert.NotContains(t, none, "--dir")
	two, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{OpencodeURL: "http://127.0.0.1:4711", OpencodeMajor: 2, WorkingDir: "/w"})
	require.NoError(t, err)
	assert.NotContains(t, two, "--dir", "2.x's TUI is not changed by what was found on 1.x")
}

// The same launch line in PowerShell (a Windows pane's shell) on any platform: the password is read from the private file into $env:, never typed, and 1.x gets only its own variable. CORAL_SHELL must name a real file,
// so a stand-in named pwsh.exe is made.
func TestOpencodeLaunchLineInPowerShellReadsThePasswordFromTheFile(t *testing.T) {
	pwsh := filepath.Join(t.TempDir(), "pwsh.exe")
	require.NoError(t, os.WriteFile(pwsh, []byte("stand-in"), 0o755))
	t.Setenv("CORAL_SHELL", pwsh)
	require.Equal(t, ShellPowerShell, detectShell())
	for major, wantCopy := range map[int]bool{0: true, 1: false, 2: true} {
		cmd, err := (&OpencodeAgent{}).LaunchCommand(LaunchParams{OpencodeURL: "http://127.0.0.1:4711", OpencodePasswordFile: "C:\\data\\opencode\\password", OpencodeMajor: major, Flags: []string{"-p", "hunter2"}})
		require.NoError(t, err)
		assert.Contains(t, cmd, "$env:OPENCODE_SERVER_PASSWORD = (Get-Content -Raw -LiteralPath 'C:\\data\\opencode\\password').Trim();", "major %d", major)
		assert.Equal(t, wantCopy, strings.Contains(cmd, "$env:OPENCODE_PASSWORD = $env:OPENCODE_SERVER_PASSWORD;"), "major %d", major)
		assert.NotContains(t, cmd, "export ", "major %d: no POSIX syntax in a PowerShell line", major)
		assert.NotContains(t, cmd, "hunter2", "major %d", major)
	}
}
