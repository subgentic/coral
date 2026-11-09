package agent

import (
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// agyAutoModeCache keeps, per file (path, size and modification time), whether that agy's own --help lists "auto" among the values of --mode, so a launch does not run the program every time and an agy that
// is updated in place is asked again (#14741).
var agyAutoModeCache sync.Map

// agyAutoValue is "auto" as one value of a list, "(accept-edits, auto, plan)": never "--auto-approve" or a word that only contains it.
var agyAutoValue = regexp.MustCompile(`(?i)(^|[\s(,|/])auto([\s),|/.]|$)`)

// agyHelpListsAutoMode reports whether the --mode line of agy's help names auto.
func agyHelpListsAutoMode(help string) bool {
	for _, line := range strings.Split(help, "\n") {
		t := strings.TrimSpace(line)
		if !strings.HasPrefix(t, "--mode") {
			continue
		}
		if strings.HasPrefix(strings.TrimPrefix(t, "--mode"), "=") || strings.HasPrefix(strings.TrimPrefix(t, "--mode"), " ") || t == "--mode" {
			return agyAutoValue.MatchString(strings.TrimSpace(strings.TrimPrefix(t, "--mode")))
		}
	}
	return false
}

// AgySupportsAutoMode asks the agy at bin (its own --help, never assumed from a version) whether --mode takes auto. A program that cannot be asked, or that does not list it, is "no": the launch then
// carries no auto flag and the agent asks, and no skip flag takes its place (Security's ruling on #14741, point (a)).
func AgySupportsAutoMode(bin string) bool {
	resolved := bin
	if p, err := exec.LookPath(bin); err == nil {
		resolved = p
	}
	key := resolved
	if fi, err := os.Stat(resolved); err == nil {
		key += "\x00" + strconv.FormatInt(fi.Size(), 10) + "\x00" + fi.ModTime().UTC().Format("20060102150405.000000000")
	}
	if v, ok := agyAutoModeCache.Load(key); ok {
		return v.(bool)
	}
	ok := agyHelpListsAutoMode(cliHelp(resolved))
	agyAutoModeCache.Store(key, ok)
	return ok
}
