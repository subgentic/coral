package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/hermesdb"
)

// HermesAgent implements the Agent interface for Hermes Agent (Nous Research, #11831; checked on v0.22.5): `hermes chat` in the agent's pane. Hermes keeps no transcript file: its sessions are rows in
// $HERMES_HOME/state.db (a SQLite database), which Coral reads through internal/hermesdb, so there is no history folder or glob here.
type HermesAgent struct{}

func (a *HermesAgent) AgentType() string    { return at.Hermes }
func (a *HermesAgent) SupportsResume() bool { return true }

// HistoryBasePath and HistoryGlobPattern are empty: the file indexer has nothing to walk (the sessions are in state.db).
func (a *HermesAgent) HistoryBasePath() string    { return "" }
func (a *HermesAgent) HistoryGlobPattern() string { return "" }

// hermesWindowsInstallNote is all a Windows server says: Hermes on Windows (a separate PowerShell installer) has not been tried with Coral.
const hermesWindowsInstallNote = "Hermes on Windows has not been tried with Coral yet. The vendor's page has its own Windows installer."

// hermesInstallCommand is the vendor's installer line, shown where Hermes is missing; Coral never runs it (the installer is a curl-to-bash script that takes minutes and gigabytes). hermesInstallNote says so.
const (
	hermesInstallCommand = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
	hermesInstallNote    = "The installer puts hermes in ~/.local/bin and its files in ~/.hermes (about 2.4 GB), and takes several minutes. Coral looks in ~/.local/bin too, so it finds hermes either way. Coral never runs the installer for you."
)

// IsHermesSessionID reports whether id is a Hermes session id as `hermes chat` writes it: local- and exactly 64 lowercase hex digits (hermesdb.IsSessionID, the one rule the state.db reader asks by too). It is the
// only form a resume id may take (the 8-character id in the banner is not one: --resume answers "Session not found"), and it reaches the command line as the value of --resume, never as text the shell reads.
func IsHermesSessionID(id string) bool { return hermesdb.IsSessionID(id) }

// hermesOwnFlags are flags Coral sets itself, or that would change what Coral relies on (which session, whether a command asks, whether hooks are accepted, where it works, how it answers): dropped from a person's
// flags. The permission flags of the other CLIs are dropped too: Hermes has one, --yolo, which LaunchCommand lets through once (the callers add it from Coral's permission mode). hermesValueFlags are those that take a value.
var hermesOwnFlags = map[string]bool{
	"--resume": true, "-r": true, "--continue": true, "-c": true, "--query": true, "-q": true, "--oneshot": true, "-Q": true, "-z": true,
	"--accept-hooks": true, "--in": true, "--source": true, "--ignore-rules": true,
	"--permission-mode": true, "--settings": true, "--session-id": true, "--dangerously-skip-permissions": true, "--full-auto": true,
	"--approval-mode": true, "--sandbox": true, "--session": true, "--session-dir": true,
}

var hermesValueFlags = map[string]bool{
	"--resume": true, "-r": true, "--query": true, "-q": true, "--in": true, "--source": true,
	"--permission-mode": true, "--settings": true, "--session-id": true, "--approval-mode": true, "--sandbox": true, "--session": true, "--session-dir": true,
}

// LaunchCommand builds `hermes chat [--resume <id>] [--yolo] [flags]`. Nothing the agent is told goes on the line (an argument shows in ps, and in the shell's history): no -q prompt and no board protocol. The
// first prompt and the board's messages are typed into the pane once Hermes is ready, as every other typed message is (the protocol is the agent's first message).
func (a *HermesAgent) LaunchCommand(params LaunchParams) (string, error) {
	bin := resolveBinary(params.CLIPath, "hermes")
	// The agent runs in its team's own Hermes home, never the person's: a launch that cannot make it does not start (and never falls back to ~/.hermes).
	home, err := PrepareHermesHome(hermesDataDir(params), params.BoardName, PersonalHermesHome(), time.Now())
	if err != nil {
		return "", fmt.Errorf("hermes: the team's Hermes home could not be made: %w", err)
	}
	var parts, raw []string
	export := formatEnvExport("HERMES_HOME", home)
	parts, raw = append(parts, export), append(raw, export)
	parts = append(parts, bin, "chat")
	if id := params.ResumeSessionID; id != "" && IsHermesSessionID(id) { // one that is not one is ignored: a fresh session, never an argument made of it
		parts = append(parts, "--resume", id)
	}
	skipNext, yolo := false, false
	for _, flag := range params.Flags {
		if skipNext {
			skipNext = false
			continue
		}
		if flag == "--yolo" { // the one permission switch Hermes has, put in Flags by the caller from Coral's permission mode (PermissionFlagsForAgent; a person's own is stripped before, SplitPermissionFlags): once
			if !yolo {
				parts = append(parts, flag)
			}
			yolo = true
			continue
		}
		if name, _, hasValue := strings.Cut(flag, "="); hermesOwnFlags[name] {
			skipNext = !hasValue && hermesValueFlags[name]
			continue
		}
		parts = append(parts, flag)
	}
	parts, raw = withSessionToken(parts, raw, params, at.Hermes)
	return ShellJoin(parts, raw...), nil
}

// PersonalHermesHome is the person's own Hermes home: $HERMES_HOME, else ~/.hermes. Coral only reads its config.yaml and .env, to seed a team's home (hermes_home.go); it never writes there.
func PersonalHermesHome() string {
	if v := os.Getenv("HERMES_HOME"); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".hermes")
	}
	return ""
}

// hermesDataDir is the Coral data folder a launch's team home lives under: the launch's own, else CORAL_DATA_DIR, else ~/.coral.
func hermesDataDir(params LaunchParams) string {
	if params.CoralDir != "" {
		return params.CoralDir
	}
	if v := os.Getenv("CORAL_DATA_DIR"); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".coral")
	}
	return ""
}
