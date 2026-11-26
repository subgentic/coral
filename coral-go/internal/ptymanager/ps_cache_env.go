package ptymanager

import (
	"path/filepath"
	"strings"
)

// psCacheEnvName is where Windows PowerShell 5.1 keeps its module analysis cache file.
const psCacheEnvName = "PSModuleAnalysisCachePath"

// psModuleCacheEnv is the PSModuleAnalysisCachePath entry for an agent's pane shell on Windows (#21605). PowerShell 5.1 asks Windows for the Local AppData folder; when
// USERPROFILE points at a home with no AppData\Local that comes back empty and it writes Microsoft\Windows\PowerShell\ModuleAnalysisCache relative to the current folder,
// which is the repository the agent works in. A value the person already set is kept (nil here). Otherwise the file goes under LOCALAPPDATA, or under Coral's data folder
// when LOCALAPPDATA is empty or unset. env is "NAME=value" entries, names compared without case as Windows does; dataDir is Coral's data folder.
func psModuleCacheEnv(env []string, dataDir string) []string {
	var local string
	for _, kv := range env {
		name, val, _ := strings.Cut(kv, "=")
		switch {
		case strings.EqualFold(name, psCacheEnvName) && val != "":
			return nil
		case strings.EqualFold(name, "LOCALAPPDATA"):
			local = val
		}
	}
	base := local
	if base == "" {
		base = dataDir
	}
	if base == "" {
		return nil
	}
	return []string{psCacheEnvName + "=" + filepath.Join(base, "Microsoft", "Windows", "PowerShell", "ModuleAnalysisCache")}
}
