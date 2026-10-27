package startup

import (
	"log"
	"os"

	"github.com/subgentic/coral/internal/updater/runrecord"
)

// recordLaunch writes where this Coral lives (its data folder, home folder and port) to <data dir>/updates/launch.json, for the macOS and Windows relaunch after an update to carry over (#9056).
// It is called by every server start (the one program of coral, and the tray's server child, which is what an installed Mac or Windows app runs), not by one of their entry points. A failure only
// logs: the relaunch then starts the app as it always did.
func recordLaunch(dataDir string, port int) {
	home, _ := os.UserHomeDir()
	if err := runrecord.WriteLaunch(dataDir, runrecord.Launch{DataDir: dataDir, Home: home, Port: port}); err != nil {
		log.Printf("[update] where Coral lives is not recorded (an update will restart it as the app starts by default): %v", err)
	}
}
