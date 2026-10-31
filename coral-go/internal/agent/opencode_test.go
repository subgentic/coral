package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

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
	assert.Contains(t, cmd, `OPENCODE_SERVER_PASSWORD="$(cat '/data/opencode/password')"`, "read from the private file by the pane's shell")
	assert.Contains(t, cmd, `export OPENCODE_PASSWORD="$OPENCODE_SERVER_PASSWORD"`, "a build whose version is not said gets both variables")
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
	assert.Contains(t, cmd, `export OPENCODE_SERVER_PASSWORD="$(cat '/data/opencode/password')"`, "the variable 1.x reads, from the private file")
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
	assert.Contains(t, cmd, `export OPENCODE_SERVER_PASSWORD="$(cat '/data/opencode/password')"`)
	assert.Contains(t, cmd, `export OPENCODE_PASSWORD="$OPENCODE_SERVER_PASSWORD"`)
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
