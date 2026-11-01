package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

const hermesID = "local-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestHermesIsALaunchableType(t *testing.T) {
	require.NoError(t, ValidateAgentType(at.Hermes))
	assert.Contains(t, LaunchableAgentTypes(), at.Hermes)
	assert.Equal(t, at.Hermes, GetAgent(at.Hermes).AgentType())
	assert.True(t, GetAgent(at.Hermes).SupportsResume())
	info := GetCLIInfo(at.Hermes)
	require.NotNil(t, info)
	assert.Equal(t, "hermes", info.Binary)
}

// Only local- and exactly 64 lowercase hex resume (the banner's 8-character id, a path, an option and an upper-case id are all refused), for the safe-charset rule and for IsResumeID.
func TestHermesResumeIDIsOnlyTheRealForm(t *testing.T) {
	assert.True(t, IsHermesSessionID(hermesID))
	assert.True(t, IsResumeID(at.Hermes, hermesID))
	for _, id := range []string{
		"", "d7b90358", "local-", "local-abc", hermesID + "0", hermesID[:len(hermesID)-1], strings.ToUpper(hermesID), "Local-" + hermesID[6:],
		"local-" + strings.Repeat("g", 64), "--yolo", "-" + hermesID, "latest", "../" + hermesID, hermesID + "\n", " " + hermesID, hermesID + " --yolo",
		"local-" + strings.Repeat("0", 63) + "/", "20260924_120000_abcdef", "11111111-1111-4111-8111-111111111111",
	} {
		assert.False(t, IsHermesSessionID(id), id)
		assert.False(t, IsResumeID(at.Hermes, id), id)
	}
	// the other types do not take the Hermes form
	assert.False(t, IsResumeID(at.Pi, hermesID))
}

func TestHermesLaunchLine(t *testing.T) {
	ag := GetAgent(at.Hermes)
	cmd, err := ag.LaunchCommand(LaunchParams{SessionID: "s1", ResumeSessionID: hermesID, Prompt: "SECRET-PROMPT", ProtocolPath: "/nope"})
	require.NoError(t, err)
	assert.Contains(t, cmd, "hermes chat --resume "+hermesID)
	assert.NotContains(t, cmd, "SECRET-PROMPT", "no prompt on the line")
	assert.NotContains(t, cmd, " -q", "no seed prompt")
	assert.NotContains(t, cmd, "--yolo", "ask first by default")
	assert.NotContains(t, cmd, "--accept-hooks")

	// a resume id that is not the form is ignored: a fresh session
	for _, bad := range []string{"d7b90358", "--yolo", "latest", "local-x"} {
		cmd, err = ag.LaunchCommand(LaunchParams{SessionID: "s1", ResumeSessionID: bad})
		require.NoError(t, err)
		assert.NotContains(t, cmd, "--resume", bad)
		assert.NotContains(t, cmd, "--yolo", bad)
	}
}

// The permission switch is Coral's: Bypass permissions (put in Flags by the caller) is --yolo, once; the others ask. A person's own flags that name a session, a prompt, hooks or another CLI's permission mode are dropped with their values.
func TestHermesFlags(t *testing.T) {
	assert.Equal(t, []string{"--yolo"}, PermissionFlagsForAgent(at.Hermes, "bypassPermissions"))
	for _, m := range []string{"", "default", "plan", "acceptEdits", "auto", "dontAsk"} {
		assert.Empty(t, PermissionFlagsForAgent(at.Hermes, m), m)
	}
	ag := GetAgent(at.Hermes)
	cmd, err := ag.LaunchCommand(LaunchParams{SessionID: "s1", Flags: append(PermissionFlagsForAgent(at.Hermes, "bypassPermissions"), "--yolo", "-m", "some-model", "--reasoning", "high")})
	require.NoError(t, err)
	assert.Equal(t, 1, strings.Count(cmd, "--yolo"))
	assert.Contains(t, cmd, "-m some-model")
	assert.Contains(t, cmd, "--reasoning high")

	cmd, err = ag.LaunchCommand(LaunchParams{SessionID: "s1", Flags: []string{
		"--resume", "latest", "-c", "-q", "do it", "--accept-hooks", "--in", "/etc", "--source", "x", "--permission-mode", "bypassPermissions",
		"--dangerously-skip-permissions", "--sandbox", "danger-full-access", "--approval-mode=yolo", "--ignore-rules", "-Q", "--model", "m",
	}})
	require.NoError(t, err)
	for _, gone := range []string{"latest", "do it", "--accept-hooks", "/etc", "--source", "bypassPermissions", "--dangerously", "danger-full-access", "yolo", "--ignore-rules", " -Q", " -c", " -q"} {
		assert.NotContains(t, cmd, gone)
	}
	assert.Contains(t, cmd, "--model m")
}

// Any Hermes flag Coral does not list keeps the prompts on only for the model and reasoning words, so a Hub request for --yolo counts as skipping.
func TestHermesYoloCountsAsSkipping(t *testing.T) {
	assert.True(t, SkipsPermissionPrompts(at.Hermes, []string{"--yolo"}))
	assert.True(t, SkipsPermissionPrompts(at.Hermes, []string{"--accept-hooks"}))
	assert.False(t, SkipsPermissionPrompts(at.Hermes, []string{"--model", "m"}))
}
