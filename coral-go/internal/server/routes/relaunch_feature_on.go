//go:build !relaunchfixture

package routes

// updateRelaunchFeature is true in every build (#13258): Coral Hub's owner may relaunch a computer into an update that computer has already staged and verified, and ask it to check for one. A constant on purpose:
// nothing a request, a setting, a flag or the environment can turn it off or on. What still gates each request is the person at that computer: the switch "relaunch to install updates" (hub_relaunch_updates, off
// until they turn it on, never written through the Hub), the max-mode cap, the Operator opt-out, the stamped owner and the agents guard (system_update_relaunch.go). The relaunchfixture build keeps the fixture updater.
const updateRelaunchFeature = true

// BuildRelaunchUpdater is the updater the server's relaunch routes use: the real one (relaunch_real.go). quit ends the server after a relaunch was started.
func BuildRelaunchUpdater(coralDir string, quit func()) RelaunchUpdater {
	return NewRealUpdater(coralDir, quit)
}
