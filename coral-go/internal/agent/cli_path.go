package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ValidateCLIPath checks a cli_path_<type> setting (Settings > Providers) before it is
// saved (#3364): an absolute path to an existing, executable regular file (a symlink
// to one is fine), with no shell metacharacters or control characters. The launch line
// quotes it either way (#3362); this keeps a typo or a hostile value from being saved.
func ValidateCLIPath(path string) error {
	if path == "" {
		return nil // clears the setting: the CLI is found on PATH again
	}
	for _, r := range path {
		if r < 0x20 || r == 0x7f || strings.ContainsRune("'\"`$;&|<>*?!", r) {
			return fmt.Errorf("the CLI path must not contain %q", r)
		}
	}
	if !filepath.IsAbs(path) {
		return errors.New("the CLI path must be absolute (for example /usr/local/bin/claude)")
	}
	// A path through junctions Windows will not open (an untrusted mount point, #340) is followed to the program it leads to (#582): the path is saved as the person typed it
	// (the installer's), and launch follows it again each time, so the CLI's own updates (a new version folder) are followed too.
	real, err := RealCLIPath(path)
	if err != nil {
		var unfollowed *UnfollowedChainError
		if errors.As(err, &unfollowed) {
			return unfollowed
		}
		return fmt.Errorf("no file at %s", path)
	}
	path = real
	info, err := statCLI(path)
	if err != nil {
		return fmt.Errorf("no file at %s", path)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a file", path)
	}
	if !isExecutableFile(path, info) {
		return fmt.Errorf("%s is not executable", path)
	}
	return nil
}

func isExecutableFile(path string, info os.FileInfo) bool {
	if runtime.GOOS == "windows" {
		switch strings.ToLower(filepath.Ext(path)) {
		case ".exe", ".cmd", ".bat", ".com", ".ps1":
			return true
		}
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

// IsCLIPathSetting reports whether key is a cli_path_<type> setting, and for which
// known agent type.
func IsCLIPathSetting(key string) (agentType string, ok bool) {
	t, found := strings.CutPrefix(key, "cli_path_")
	if !found {
		return "", false
	}
	return t, true
}

// KnownCLIAgentType reports whether agentType has a CLI Coral launches.
func KnownCLIAgentType(agentType string) bool {
	return GetCLIInfo(agentType) != nil
}
