//go:build webview

package main

import (
	"runtime"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/license"
	"github.com/subgentic/coral/internal/tracking"
)

// checkAndShowEULA checks if the user has accepted the EULA.
// Skipped in dev tier (compile-time build tag).
// dataDir is the Coral data folder: showing and declining the Terms are held there as funnel steps (#7455), on disk only, and sent by the server once the
// Terms are accepted with analytics on.
func checkAndShowEULA(dataDir string) bool {
	if !config.EULARequired() {
		return true
	}
	surface := tracking.EULASurfaceDialog
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		surface = tracking.EULASurfaceConsole // eula_other.go asks in the terminal
	}
	tracking.SetCoralDir(dataDir)
	return license.CheckAndPromptEULA(tracking.ObserveEULADialog(surface, showEULADialog))
}
