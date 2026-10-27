package apply

import (
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/updater/runrecord"
)

// trayStartArgs are the arguments of the coral-tray the Windows relaunch starts: --no-browser unless the window was open when the update began (#5827), and the port Coral ran
// with, as the server recorded it (#9056).
func trayStartArgs(windowOpen bool, launch runrecord.Launch) []string {
	args := []string{}
	if !windowOpen {
		args = append(args, "--no-browser")
	}
	if launch.Port != 0 {
		args = append(args, "--port", strconv.Itoa(launch.Port))
	}
	return args
}

// withDataDir makes CORAL_DATA_DIR in env the recorded data folder (when there is one), replacing a value the updater's own environment holds.
func withDataDir(env []string, dir string) []string {
	if dir == "" {
		return env
	}
	var out []string
	for _, kv := range env {
		if name, _, _ := strings.Cut(kv, "="); strings.EqualFold(name, "CORAL_DATA_DIR") {
			continue
		}
		out = append(out, kv)
	}
	return append(out, "CORAL_DATA_DIR="+dir)
}
