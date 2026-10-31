package testguard

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// agentShellVars and agentShellPrefixes name what Coral puts in an agent's shell: its
// identity, its links to production (Cloud Hub URL, hub mode, tmux socket) and its
// workflow/step context. 'go test' run from an agent shell would otherwise hand them to
// every test that reads the environment, e.g. a config built from CORAL_HUB. Keep in step
// with tests/lib/agent_env.sh and AGENT_SHELL_VARS in tests/frontend/run_cdp_suites.mjs.
var agentShellVars = []string{
	"CORAL_SESSION_NAME", "CORAL_SESSION_ID", "CORAL_SESSION_TOKEN", "CORAL_SESSION_AUTH_FILE", "CORAL_SUBSCRIBER_ID", "CORAL_CLOUD_URL", "CORAL_HUB", "CORAL_SHELL",
	"CORAL_TMUX_SOCKET", "CORAL_TMUX_FALLBACK", "CORAL_AGENT_HELPER", "CORAL_AGENT_ARGS", "CORAL_BOARD_HELPER", "CORAL_BOARD_ARGS",
}

// credentialPrefixes are the families an agent CLI's own session exports: the Claude Code session (CLAUDE_CODE_SESSION_ID, CLAUDE_PID, its messaging socket and token), API keys and OAuth
// tokens (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN), and the Codex, Gemini and Pi homes. Run from an agent's shell, a test process would hold a REAL credential
// (#413). A test that needs one sets it with t.Setenv or a child's Env, as the real-CLI tests already do. This is the safety half; for the test CACHE the go tool's own environment
// must also be the same in every shell (the cache hashes the go tool's value of each variable a test reads), which tools/ and the Makefile test target handle.
var credentialPrefixes = []string{"CLAUDE_", "ANTHROPIC_", "CODEX_", "GEMINI_", "PI_", "OPENAI_", "GOOGLE_", "AWS_"}

// credentialNames are single variables of the same kind: forge and agent credentials a shell may carry. GITHUB_ is not a prefix here (GITHUB_ACTIONS is a CI marker tests read).
var credentialNames = []string{"GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"}

// agentHomePointers name where an agent CLI keeps its sign-in files. Dropping them would send a test that reads the folder to the person's REAL ~/.codex or ~/.claude (the default under the home
// folder), where the credentials live, so they are not dropped: each is pointed at a folder that does not exist, per process. A package whose TestMain makes a private home (testtemp) has them
// removed again there (they are listed in sandboxedPointers for it), so the default under THAT home applies, as the tests expect. A test that wants one sets it with t.Setenv.
var agentHomePointers = []string{"CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "GEMINI_CLI_HOME", "GEMINI_TMP_DIR", "ANTIGRAVITY_DATA_DIR"}

// SandboxedPointersEnv lists (comma separated) the pointers this init pointed at the sandbox, for testtemp to remove once HOME is private. Not a CORAL_ name.
const SandboxedPointersEnv = "TESTGUARD_SANDBOXED_POINTERS"

var agentShellPrefixes = append([]string{"CORAL_WORKFLOW_", "CORAL_PREV", "CORAL_STEP_"}, credentialPrefixes...)

// scrubbedMarker is set once the scrub has run, and test binaries started from a test
// (helper re-execs such as the CLI help tests) inherit it, so they keep the CORAL_* values
// their parent test gave them on purpose.
// Not a CORAL_ name: some helper re-execs drop every inherited CORAL_* variable.
const scrubbedMarker = "TESTGUARD_AGENT_ENV_SCRUBBED"

// init clears them from the environment of the test binary that 'go test' starts, before
// any test runs. Shipped binaries are untouched. Tests that need one set it themselves
// (t.Setenv, or a child process's Env).
func init() {
	if !InTest() || os.Getenv(scrubbedMarker) == "1" {
		return
	}
	scrubAgentShellEnv()
	os.Setenv(scrubbedMarker, "1")
}

func scrubAgentShellEnv() {
	for _, k := range agentShellVars {
		os.Unsetenv(k)
	}
	for _, k := range credentialNames {
		os.Unsetenv(k)
	}
	isolateDataDir()
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		for _, p := range agentShellPrefixes {
			if strings.HasPrefix(k, p) {
				os.Unsetenv(k)
				break
			}
		}
	}
	// after the prefix drop (CODEX_, CLAUDE_, PI_, GEMINI_ cover these names): point, do not leave unset
	sandbox := filepath.Join(os.TempDir(), "coral-testguard-agent-"+strconv.Itoa(os.Getpid()))
	for _, k := range agentHomePointers {
		os.Setenv(k, filepath.Join(sandbox, strings.ToLower(k)))
	}
	os.Setenv(SandboxedPointersEnv, strings.Join(agentHomePointers, ","))
}

// isolateDataDir keeps a test binary out of the production data folder. Agent
// shells export CORAL_DATA_DIR / CORAL_DIR pointing at ~/.coral, and without
// them Coral falls back to ~/.coral itself, so a test that resolved the data
// folder the way the server or a CLI does read production's files: with the
// command-line token there, `coral auto-accept off` in a test signed with it.
// CORAL_DIR is dropped and CORAL_DATA_DIR points at a per-process folder under
// the temp dir, not created here (a test that needs one sets its own with
// t.Setenv or t.TempDir). HOME is left alone: Go's build cache lives under it,
// and tests that build binaries would start from an empty cache.
func isolateDataDir() {
	os.Unsetenv("CORAL_DIR")
	os.Setenv("CORAL_DATA_DIR", filepath.Join(os.TempDir(), "coral-testguard-data-"+strconv.Itoa(os.Getpid())))
}
