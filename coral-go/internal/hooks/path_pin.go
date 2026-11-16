package hooks

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/subgentic/coral/internal/secfile"
)

// PinToolsPath makes the agent's own shell find THIS build's coral-agent and coral-board first, whatever order its PATH has been put in (#18643): the launch line and the settings
// file already put the tools folder first, but a login shell's path_helper, a profile that prepends, or the CLI's shell snapshot can put another Coral (the installed app's, older)
// ahead of it, and an agent then ran 2.0.68's coral-agent next to this build's hooks ("Unknown command: ask"). Claude Code sources $CLAUDE_ENV_FILE before every Bash command,
// after its snapshot, so a line written there is the last word on PATH for that session.
//
// envFile is $CLAUDE_ENV_FILE (empty: the CLI offers none, nothing is done); dir is the folder this hook runs from, the bundle's tools folder. Nothing is written when dir holds
// no coral-agent or coral-board (a hook run from somewhere else must not pin an arbitrary folder), on Windows (a different path syntax; the launch line covers it), or when
// the line is already there (SessionStart fires again on a resume, a clear and a compaction).
func PinToolsPath(envFile, dir string) error {
	if envFile == "" || dir == "" || runtime.GOOS == "windows" {
		return nil
	}
	if !hasTool(dir, "coral-agent") && !hasTool(dir, "coral-board") {
		return nil
	}
	line := pinLine(dir)
	if old, err := os.ReadFile(envFile); err == nil && strings.Contains(string(old), line) {
		return nil
	}
	f, err := secfile.OpenNoFollow(envFile, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.WriteString(line)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

// pinLine is the shell line: dir quoted as a literal, only $PATH expanded.
func pinLine(dir string) string {
	q := "'" + strings.ReplaceAll(dir, "'", `'\''`) + "'"
	return "export PATH=" + q + `:"$PATH"` + "\n"
}

func hasTool(dir, name string) bool {
	st, err := os.Stat(filepath.Join(dir, name))
	return err == nil && st.Mode().IsRegular()
}

// SelfDir is the folder the running program is in, or "".
func SelfDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(exe)
}
