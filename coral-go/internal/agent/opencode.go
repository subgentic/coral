package agent

import (
	"fmt"
	"regexp"
	"strings"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// OpencodeAgent implements the Agent interface for opencode (v2): the TUI in the agent's pane, attached to the one opencode server Coral runs for its data scope (internal/opencode) with `--server <url>`, so
// Coral reads its state from the server's events and its history through the server's API, never from opencode's database (#11364). The server's password reaches the pane only as the OPENCODE_PASSWORD
// variable, read from a private file by the shell Coral types the line into: not in the argument list, not in the line, not in a log.
type OpencodeAgent struct{}

func (a *OpencodeAgent) AgentType() string    { return at.Opencode }
func (a *OpencodeAgent) SupportsResume() bool { return true }

// HistoryBasePath is empty: opencode keeps no transcript file Coral reads; the history comes through the server's API.
func (a *OpencodeAgent) HistoryBasePath() string    { return "" }
func (a *OpencodeAgent) HistoryGlobPattern() string { return "" }

// opencodeSessionRe is an opencode session id as it is written: ses_ and word characters. It is the only form a resume id may take, and it is passed after --session as its own argument.
var opencodeSessionRe = regexp.MustCompile(`^ses_[A-Za-z0-9_-]{1,120}$`)

// IsOpencodeSessionID reports whether id is an opencode session id.
func IsOpencodeSessionID(id string) bool { return opencodeSessionRe.MatchString(id) }

// opencodeOwnFlags are flags Coral sets itself, or that would aim the TUI at another server or session than Coral's: dropped from a person's flags (with the value of those that take one).
var opencodeOwnFlags = map[string]bool{
	"--server": true, "--session": true, "-s": true, "--continue": true, "-c": true, "--standalone": true, "--fork": true,
	"--permission-mode": true, "--settings": true, "--session-id": true, "--dangerously-skip-permissions": true, "--full-auto": true,
	"--approval-mode": true, "--sandbox": true, "--yolo": true, "--password": true, "--username": true,
}

var opencodeValueFlags = map[string]bool{
	"--server": true, "--session": true, "-s": true, "--permission-mode": true, "--settings": true, "--session-id": true,
	"--approval-mode": true, "--sandbox": true, "--password": true, "--username": true,
}

func (a *OpencodeAgent) LaunchCommand(params LaunchParams) (string, error) {
	if params.OpencodeURL == "" {
		return "", fmt.Errorf("opencode: Coral's opencode server is not running")
	}
	bin := resolveBinary(params.CLIPath, "opencode")
	var parts, raw []string
	for _, kv := range CoralEnv(params) {
		export := formatEnvExport(kv[0], kv[1])
		raw = append(raw, export)
		parts = append(parts, export)
	}
	if f := params.OpencodePasswordFile; f != "" {
		line := opencodePasswordPrefix(f)
		raw = append(raw, line)
		parts = append(parts, line)
	}
	parts = append(parts, bin, "--server", params.OpencodeURL)
	if id := params.ResumeSessionID; id != "" && IsOpencodeSessionID(id) { // an id that is not one is ignored: a fresh session, never an argument made of it
		parts = append(parts, "--session", id)
	}
	skipNext := false
	for _, flag := range params.Flags {
		if skipNext {
			skipNext = false
			continue
		}
		if name, _, hasValue := strings.Cut(flag, "="); opencodeOwnFlags[name] {
			skipNext = !hasValue && opencodeValueFlags[name]
			continue
		}
		parts = append(parts, flag)
	}
	parts, raw = withSessionToken(parts, raw, params, at.Opencode)
	return ShellJoin(parts, raw...), nil
}

// opencodePasswordPrefix sets OPENCODE_PASSWORD in the pane's shell from the private file Coral wrote it to, as the session token is set: the secret is not in the line that is typed.
func opencodePasswordPrefix(file string) string {
	q := shellQuoteLiteral(file)
	switch detectShell() {
	case ShellPowerShell:
		return fmt.Sprintf("$env:OPENCODE_PASSWORD = (Get-Content -Raw -LiteralPath %s).Trim();", q)
	default:
		return fmt.Sprintf(`export OPENCODE_PASSWORD="$(cat %s)";`, q)
	}
}
