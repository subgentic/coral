// Finding the agent CLIs: the binary each agent type runs, where its path setting says it is, the install notes, and the errors a launch gets when it is missing or refused. Moved out of agent.go (#8334), no code changed.

package agent

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	at "github.com/subgentic/coral/internal/agenttypes"
	setreg "github.com/subgentic/coral/internal/settings"
)

// cliNames maps board_type to CLI command name. The nil/empty key is the default.
var cliNames = map[string]string{
	"":      "coral-board",
	"coral": "coral-board",
}

// GetCLIName returns the CLI command name for the given board type.
func GetCLIName(boardType string) string {
	if cli, ok := cliNames[boardType]; ok {
		return cli
	}
	return cliNames[""]
}

// CLIInfo holds the CLI binary name and install instructions for an agent type.
type CLIInfo struct {
	Binary         string `json:"binary"`
	InstallCommand string `json:"install_command"`
	// InstallURL is the vendor's own install page (never a third-party guide), shown as a link where the CLI is missing.
	InstallURL string `json:"install_url"`
	// InstallNote is what to do after installing, when the installer leaves the CLI where PATH may not reach (agy: ~/.local/bin).
	InstallNote string `json:"install_note,omitempty"`
}

// agyInstallNote: the Antigravity installer puts agy in ~/.local/bin. Coral looks there itself (FindCLIInCommonPaths), so it finds
// agy even when that folder is not on PATH; a terminal of your own needs it on PATH.
const agyInstallNote = "The installer puts agy in ~/.local/bin. Coral looks there too, so it finds agy either way. To run agy in your own terminal, put that folder on your PATH: add export PATH=\"$HOME/.local/bin:$PATH\" to ~/.zshrc or ~/.bashrc, then open a new terminal."

// Antigravity's official installer (the script moved from /install.sh to /cli/install.sh) and its official page.
const (
	agyInstallCommand = "curl -fsSL https://antigravity.google/cli/install.sh | bash"
	agyInstallURL     = "https://antigravity.google"
)

// On Windows the vendor's page gives its own lines (PowerShell and CMD): the macOS and Linux line needs bash, and curl in PowerShell is Invoke-WebRequest. PowerShell is what Coral's Windows
// terminals use. The installer puts agy.exe in %LOCALAPPDATA%\agy\bin (FindCLIInCommonPaths looks there) and sets up the shell, which a terminal opened before it does not see.
const (
	agyWindowsInstallCommand = "irm https://antigravity.google/cli/install.ps1 | iex"
	agyWindowsInstallNote    = "Run this in PowerShell. The installer puts agy.exe in %LOCALAPPDATA%\\agy\\bin. Coral looks there too, so it finds agy either way. To run agy in a terminal of your own, open a new terminal after the install so it picks up the PATH change."
)

// agentCLIs maps agent types to their required CLI tools and install instructions (for macOS and Linux; GetCLIInfo gives the Windows line of agy on Windows).
var agentCLIs = map[string]CLIInfo{
	at.Claude:      {Binary: "claude", InstallCommand: "npm install -g @anthropic-ai/claude-code", InstallURL: "https://code.claude.com/docs/en/overview"},
	at.Agy:         {Binary: "agy", InstallCommand: agyInstallCommand, InstallURL: agyInstallURL, InstallNote: agyInstallNote},
	at.Antigravity: {Binary: "agy", InstallCommand: agyInstallCommand, InstallURL: agyInstallURL, InstallNote: agyInstallNote},
	at.Gemini:      {Binary: "agy", InstallCommand: agyInstallCommand, InstallURL: agyInstallURL, InstallNote: agyInstallNote},
	at.Codex:       {Binary: "codex", InstallCommand: "npm install -g @openai/codex", InstallURL: "https://github.com/openai/codex"},
	// No --ignore-scripts, unlike Pi: opencode-ai's postinstall script links the platform binary, and without it every command says "postinstall script was not run" (checked on 1.19.5, #137997).
	at.Opencode: {Binary: "opencode", InstallCommand: "npm install -g opencode-ai", InstallURL: "https://opencode.ai"},
	at.Pi:       {Binary: "pi", InstallCommand: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent", InstallURL: "https://pi.dev"},
}

// GetCLIInfo returns CLI info for an agent type, or nil if unknown.
func GetCLIInfo(agentType string) *CLIInfo { return cliInfoFor(runtime.GOOS, agentType) }

// cliInfoFor is GetCLIInfo for the OS goos: agy (and the types that run it) has its own command and note on Windows, with no bash, export or ~/.local in them.
func cliInfoFor(goos, agentType string) *CLIInfo {
	info, ok := agentCLIs[agentType]
	if !ok {
		return nil
	}
	if goos == "windows" && info.Binary == "agy" {
		info.InstallCommand, info.InstallNote = agyWindowsInstallCommand, agyWindowsInstallNote
	}
	return &info
}

// CLIPathSettingKey returns the settings key for the agent's custom CLI path.
func CLIPathSettingKey(agentType string) string {
	return setreg.CLIPathPrefix + agentType
}

// ResolveCLIPath returns the configured CLI path for an agent type from settings,
// with cross-compatibility fallback between "agy" and "gemini".
func ResolveCLIPath(settings map[string]string, agentType string) string {
	if settings == nil {
		return ""
	}
	if p := setreg.TextFamily(settings, CLIPathSettingKey(agentType)); p != "" {
		return p
	}
	if agentType == at.Agy || agentType == at.Antigravity {
		return setreg.TextFamily(settings, CLIPathSettingKey(at.Gemini))
	}
	if agentType == at.Gemini {
		return setreg.TextFamily(settings, CLIPathSettingKey(at.Agy))
	}
	return ""
}

// CLIPathError is a configured cli_path_<type> that can't be run (#115). Error names the setting and the path; HubText names the
// setting only, for an answer that goes through Coral Hub (as the CLI check's does).
type CLIPathError struct {
	AgentType string
	Path      string
	Err       error
}

func (e *CLIPathError) Error() string {
	return fmt.Sprintf("%s CLI path \"%s\" (the setting %s, in Settings > CLI paths) can't be run (%v): fix it or clear it to use the one on PATH; Coral does not run another program in its place", e.AgentType, e.Path, CLIPathSettingKey(e.AgentType), e.Err)
}

func (e *CLIPathError) Unwrap() error { return e.Err }

func (e *CLIPathError) HubText() string {
	return fmt.Sprintf("the %s CLI path set in Settings > CLI paths (%s) can't be run; Coral does not run another program in its place: fix it or clear it to use the one on PATH", e.AgentType, CLIPathSettingKey(e.AgentType))
}

// CLINotFoundError is an agent CLI found nowhere: not set in Settings > CLI paths, not on PATH, not in the common install places (#5838). A launch answers it with a 422 and the fixed
// code cli_not_found, so a client says what to do (install it, or point Settings at it) instead of showing a server fault. Error keeps the sentence "<binary> CLI not found" (the
// launch failure's analytics category and the dashboard read it) and adds the setting.
type CLINotFoundError struct {
	AgentType      string
	Binary         string
	InstallCommand string
	InstallURL     string
}

func (e *CLINotFoundError) Error() string {
	msg := fmt.Sprintf("%s CLI not found. Install it: %s", e.Binary, e.InstallCommand)
	if e.InstallURL != "" {
		msg += fmt.Sprintf(" (the vendor's page: %s)", e.InstallURL)
	}
	return msg + fmt.Sprintf(". Already installed? Set its path in Settings > CLI paths (the setting %s).", CLIPathSettingKey(e.AgentType))
}

// FindCLI returns the executable to run for agentType, the way launch finds
// it: the configured path (cli_path_<type> in settings), then the binary on
// PATH, then the common install locations. The macOS app started from Finder
// has no Homebrew PATH, so a bare exec of "claude" fails there even though
// agents launch fine; every caller that runs an agent CLI uses this (#3169).
// A configured path that is not an executable is an error, as at launch (#4350):
// the PATH and the common locations are searched only when no path is set, so a
// broken wrapper never has the unwrapped CLI run background jobs instead
// (Security's #4431 SHOULD 4).
func FindCLI(settings map[string]string, agentType string) (string, error) {
	p, err := FindCLIForLaunch(settings, agentType)
	if err != nil {
		return "", err
	}
	// A CLI that needs node, with none Coral can use for it, fails every run it makes itself (version, sign-in check, models) with "env: node: No such file or directory": say so.
	if _, nerr := NodeDirFor(p, os.Environ()); nerr != nil {
		return "", nerr
	}
	return p, nil
}

// FindCLIForLaunch is FindCLI without the node check: an agent's launch line carries its own (NodePathPrefix), and the agent's shell may have a node Coral's process does not.
func FindCLIForLaunch(settings map[string]string, agentType string) (string, error) {
	if p := ResolveCLIPath(settings, agentType); p != "" {
		resolved, err := exec.LookPath(p)
		if err == nil {
			err = CheckRunnable(resolved)
		}
		if err == nil {
			err = CheckNotRealGemini(agentType, resolved)
		}
		if err != nil {
			return "", &CLIPathError{AgentType: agentType, Path: p, Err: err}
		}
		return resolved, nil
	}
	bin := agentType
	if info := GetCLIInfo(agentType); info != nil && info.Binary != "" {
		bin = info.Binary
	}
	if p, err := exec.LookPath(bin); err == nil {
		return p, nil
	}
	if p := CommonPlaceCLI(bin, nil); p != "" {
		return p, nil
	}
	return "", fmt.Errorf("%s CLI %q not found: install it or set its path in Settings > CLI paths", agentType, bin)
}

// LaunchCLI is the program a restart, resume, wake or background launch runs for agentType (#115). A configured cli_path_<type> must be
// usable: FindCLI's answer, so one that can't be run is an error naming the setting and the path, never a silent fall back to whatever agent
// CLI is first on PATH. With none configured it is the absolute path exec.LookPath finds (which refuses the current folder), else the one
// in the common install places, rather than a bare name that is looked up again, in the agent's shell, when it runs. When nothing is found
// it is a *CLINotFoundError, as a new launch answers it (resolveLaunchCLI): the launch line never types a bare name the shell will not
// recognise ("codex is not recognized", #353). An agent type with no CLI of its own (a plain terminal) gets whatever is configured, unchecked.
func LaunchCLI(settings map[string]string, agentType string) (string, error) {
	return LaunchCLIScreened(settings, agentType, nil)
}

// LaunchCLIScreened is LaunchCLI with a screen for the common install places (CommonPlaceCLI): the routes pass the check that refuses an agent's working folder and Coral's data folder.
func LaunchCLIScreened(settings map[string]string, agentType string, screen func(path string) string) (string, error) {
	info := GetCLIInfo(agentType)
	if info == nil || info.Binary == "" {
		return ResolveCLIPath(settings, agentType), nil
	}
	if ResolveCLIPath(settings, agentType) != "" {
		return FindCLIForLaunch(settings, agentType)
	}
	if p, err := exec.LookPath(info.Binary); err == nil {
		if abs, aerr := filepath.Abs(p); aerr == nil {
			return abs, nil
		}
	}
	if p := CommonPlaceCLI(info.Binary, screen); p != "" {
		return p, nil
	}
	// Not found on PATH because a PATH folder is an untrusted mount point (Windows): the launch line's bare name would fail in the agent's shell the same way, so say why now (#340).
	if dir, bad := UntrustedMountDir(info.Binary); bad {
		return "", &CLIUntrustedMountError{AgentType: agentType, Binary: info.Binary, Dir: dir}
	}
	return "", &CLINotFoundError{AgentType: agentType, Binary: info.Binary, InstallCommand: info.InstallCommand, InstallURL: info.InstallURL}
}

// resolveBinary returns cliPath if non-empty, otherwise the default binary name.
func resolveBinary(cliPath, defaultBin string) string {
	if cliPath != "" {
		return cliPath
	}
	return defaultBin
}
