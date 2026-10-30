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
	assert.Contains(t, cmd, `OPENCODE_PASSWORD="$(cat '/data/opencode/password')"`, "read from the private file by the pane's shell")
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
