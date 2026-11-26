//go:build windows

package ptymanager

import (
	"os"
	"path/filepath"

	"github.com/subgentic/coral/internal/executil"
)

// platformAgentEnv: NoDefaultCurrentDirectoryInExePath=1 makes cmd.exe (a Claude Code hook, Codex's shell tool
// and every other `cmd /c` the agent runs) stop looking in the current folder for a program: without it a
// planted git.exe or node.exe in the repository an agent works in runs in place of the real one (#25 G1B).
// PSModuleAnalysisCachePath keeps PowerShell 5.1's module cache out of the agent's work folder (#21605).
func platformAgentEnv() []string {
	env := []string{executil.NoCwdSearchEnv}
	dataDir := os.Getenv("CORAL_DATA_DIR")
	if dataDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			dataDir = filepath.Join(home, ".coral")
		}
	}
	return append(env, psModuleCacheEnv(os.Environ(), dataDir)...)
}
