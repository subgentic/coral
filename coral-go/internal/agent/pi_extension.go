package agent

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Coral's Pi extension (#11093, #11102; design note v2.1): a small JavaScript file Pi loads with `-e` that tells Coral what the agent is doing, by starting Coral's own hook program (see
// pi_extension/coral_pi.js for what it may and may not do). It is embedded in this binary, written per launch into the launch temp folder (0600, never ~/.pi and never Pi's settings), and checked against a
// digest compiled in and again after it is written. The digest guards against another user or an accident, not against the same OS user (Pi's own bash tool can edit a file the user owns; that is no
// escalation, the agent can already run anything as that user).

//go:embed pi_extension/coral_pi.js
var piExtensionSource string

// piExtensionDigest is the SHA-256 of pi_extension/coral_pi.js as embedded: a test pins it, so the file cannot change without this line and its review changing too.
const piExtensionDigest = "f48a173315a68350d6dbe4065e737b1ecb464ef4b1f65eb1226973d1b25cc9e9"

// piConfigPlaceholder is what the extension file holds where Coral writes its configuration.
const piConfigPlaceholder = "/*__CORAL_PI_CONFIG__*/ null"

// piRuntimeEnv are the variables a hook program needs that its source does not read by name: the home folder (os.UserHomeDir), the lookup path, and on Windows the system root and temp folders.
var piRuntimeEnv = []string{"HOME", "USERPROFILE", "PATH", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"}

// piHookEnvNames are the only variables the extension passes to a hook program it starts: never Pi's whole environment, so no provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS_*, GITHUB_TOKEN)
// reaches a child. A test generates the list from the hook sources and fails when a hook reads a variable that is not here, or one is here that no hook reads (pi_env_test.go).
var piHookEnvNames = []string{
	"CORAL_DATA_DIR", "CORAL_DIR", "CORAL_HOST", "CORAL_PORT", "CORAL_SESSION_AUTH_FILE", "CORAL_SESSION_NAME", "CORAL_SESSION_TOKEN", "CORAL_SUBSCRIBER_ID", "CORAL_URL", "TMUX",
	"HOME", "USERPROFILE", "PATH", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR",
}

// piHookProgram is the one program the extension starts: Coral's agentic-state hook, from the tools folder of the Coral that launches the agent, as a plain file (not a link).
func piHookProgram() string {
	dir := CoralToolsDir()
	if dir == "" {
		return ""
	}
	name := "coral-hook-agentic-state"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	p := filepath.Join(dir, name)
	if fi, err := os.Lstat(p); err != nil || !fi.Mode().IsRegular() {
		return ""
	}
	return p
}

// piExtensionContent is the extension file for a launch: the embedded source with the configuration written in as a JSON literal (the program's path is a JSON string, never joined into code). It is "" when
// the embedded source is not the reviewed one or there is no hook program to start (the launch then has no extension, and the session-file state stands alone).
func piExtensionContent(hookBin string) string {
	if hookBin == "" || sha256Hex(piExtensionSource) != piExtensionDigest || strings.Count(piExtensionSource, piConfigPlaceholder) != 1 {
		return ""
	}
	cfg, err := json.Marshal(map[string]any{"hookBin": hookBin, "envNames": piHookEnvNames, "rev": PiExtensionRev})
	if err != nil {
		return ""
	}
	return strings.Replace(piExtensionSource, piConfigPlaceholder, string(cfg), 1)
}

// PiExtensionRev is the extension's interface revision: every hook event it posts carries it (--hooks-rev), which is the handshake the server reads (routes/hooks_status.go).
const PiExtensionRev = 1

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// piExtensionFile writes the extension for a launch and returns its path, or "" when the launch has none. The file is read back and compared with what was meant to be written just before the path is used.
func piExtensionFile(files *launchFiles, sessionID string) string {
	content := piExtensionContent(piHookProgram())
	if content == "" {
		return ""
	}
	path := files.write("pi_ext", sessionID, "js", []byte(content))
	if path == "" {
		return ""
	}
	back, err := os.ReadFile(path)
	if err != nil || sha256Hex(string(back)) != sha256Hex(content) {
		files.err = fmt.Errorf("the Pi extension file written for this launch is not what was meant to be written: not starting Pi with it")
		return ""
	}
	return path
}
