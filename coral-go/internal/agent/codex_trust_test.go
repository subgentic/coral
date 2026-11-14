package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/psquote"
)

// #153: Coral's trust for its own Codex hooks must be exactly what Codex computes, or Codex ignores it and asks. These
// are the keys and hashes Codex 0.161.0 wrote to a scratch CODEX_HOME when the person picked "Trust all and continue" for
// the hooks Coral passed (a scratch Coral whose tools were in D:\coral-team-cache\codex153-272787701\bin).
func TestCodexHookTrustMatchesWhatCodexWrites(t *testing.T) {
	command := "& 'D:/coral-team-cache/codex153-272787701/bin/coral-hook-agentic-state.exe'"
	written := map[string]string{ // key -> trusted_hash, as Codex wrote them
		`C:\<session-flags>\config.toml:session_start:0:0`:      "sha256:5879fde0d95f21d8cc2691fb3911cb94dfd032645097cf13c05bfacc95ebbd41",
		`C:\<session-flags>\config.toml:pre_tool_use:0:0`:       "sha256:1401b821aaf89cedbbfd9f35ec363180998679b93883d176d16832d0f36341e3",
		`C:\<session-flags>\config.toml:post_tool_use:0:0`:      "sha256:37ee971ab65817cdad6105260453b8c0b9a64f12de3549e7712b00d86b3096e3",
		`C:\<session-flags>\config.toml:user_prompt_submit:0:0`: "sha256:94bbd95f8dede581f1308f476aca5f9e97b37a15d44700ec4e089d052ab01e03",
		`C:\<session-flags>\config.toml:stop:0:0`:               "sha256:a3ef88f5a89a73f016b0c9abc911ca9551f3b1e80d4a9f06cecc04c3d8255789",
	}
	require.Len(t, codexHookEvents, len(written), "one trust entry per hook Coral passes")
	for _, event := range codexHookEvents {
		key := codexHookStateKey("windows", event)
		want, ok := written[key]
		require.True(t, ok, "%s: key %s", event, key)
		assert.Equal(t, want, codexHookTrustHash(event, command), event)
	}
	assert.Equal(t, "/<session-flags>/config.toml:stop:0:0", codexHookStateKey("linux", "Stop"), "elsewhere the synthetic path is made against /")

	// A changed command (another tools folder) is another hash: Codex then asks again, it never trusts a different hook.
	assert.NotEqual(t, codexHookTrustHash("Stop", command), codexHookTrustHash("Stop", strings.Replace(command, "codex153", "elsewhere", 1)))
}

// The flag is one -c setting hooks.state to an inline table: Codex splits a -c key on every "." and the keys hold
// "config.toml", so each key is a TOML literal string inside the value, and the hash a basic string.
func TestCodexHookTrustArgsShape(t *testing.T) {
	command := "& 'C:/Program Files (x86)/Coral/coral-hook-agentic-state.exe'"
	args := codexHookTrustArgs("windows", command)
	require.Len(t, args, 2)
	assert.Equal(t, "-c", args[0])
	assert.True(t, strings.HasPrefix(args[1], "hooks.state={'C:\\<session-flags>\\config.toml:session_start:0:0'={trusted_hash='sha256:"), args[1])
	assert.True(t, strings.HasSuffix(args[1], "'}}"), args[1])
	assert.NotContains(t, args[1], `"`, "#16207: no double quote, so a .cmd that starts Codex reads the whole argument as quoted text once it is wrapped (psquote.CmdArg)")
	_, wraps := psquote.CmdArg(args[1])
	assert.True(t, wraps, "the < > in the key are quoted for cmd.exe")
	for _, event := range codexHookEvents {
		assert.Contains(t, args[1], "'"+codexHookStateKey("windows", event)+"'={trusted_hash='"+codexHookTrustHash(event, command)+"'}")
	}
	assert.Equal(t, len(codexHookEvents), strings.Count(args[1], "trusted_hash="))
	assert.NotContains(t, strings.Join(args, " "), "bypass", "never Codex's --dangerously-bypass-hook-trust")
}

// The trust is given on every OS while the switch is on (#16008), whatever folder the hook tool is in; off, there is none and
// Codex shows its dialog as before. The hooks themselves are always passed.
func TestCodexHookTrustFollowsTheSwitchOnEveryOS(t *testing.T) {
	t.Cleanup(func() { codexTrustSwitch.Store(nil) })
	withHookTool(t)

	for _, on := range []bool{true, false} {
		SetCodexHookTrust(func() bool { return on })
		trusted, why := CodexHookTrust()
		args := strings.Join(codexHookArgs("sid"), " ")
		assert.Equal(t, on, trusted, "switch %v: %s", on, why)
		assert.Equal(t, on, strings.Contains(args, "hooks.state={"), "switch %v", on)
		assert.NotContains(t, args, "bypass", "never Codex's --dangerously-bypass-hook-trust")
		assert.Contains(t, args, "hooks.SessionStart=", "the hooks themselves are always passed")
		if !on {
			assert.Contains(t, why, "turned off in Settings")
		}
	}
	codexTrustSwitch.Store(nil)
	trusted, _ := CodexHookTrust()
	assert.False(t, trusted, "unwired is off: a launch nobody told the person's choice never trusts (#16128)")
	assert.NotContains(t, strings.Join(codexHookArgs("sid"), " "), "hooks.state={", "and passes no trust")
}
