package main

// installerLaunchFlag is on the command line of the one start the MSI's "Launch Coral" makes (tools/coral.wxs, #5883).
const installerLaunchFlag = "from-installer"

// installerLaunchRefused reports whether the installer's launch must start nothing: it runs in the installer's client process, as
// whoever ran the installer, so from an elevated prompt (msiexec as administrator) Coral would start elevated, and its server,
// agents and their tools would run as an administrator. A person who wants Coral elevated has the Start Menu entry and Run as
// administrator; the installer never decides it for them. Started by hand or from the shortcut (no flag), Coral starts as before.
func installerLaunchRefused(fromInstaller bool, elevated func() bool) bool {
	return fromInstaller && elevated()
}

// elevatedInstallerNote is what the person is told when the installer's "Launch Coral" is refused because the installer was run as administrator (#6004's W2): without it
// the Finish page's ticked "Launch Coral" leads to nothing and no word.
const (
	elevatedInstallerNoteTitle = "Coral"
	elevatedInstallerNote      = "Coral is installed, but it was not started: the installer was run as administrator, and Coral does not start with administrator rights.\n\nOpen Coral from the Start Menu."
)

// startTakesInstallMark says whether this run of coral-tray takes the install's restart mark (internal/installrestart): every start of
// Coral does, however it was started (the Finish page's Launch Coral with the from-installer flag, Explorer's unelevated start after an
// elevated install, which passes no flag, the Start Menu), so a mark is never left behind to start a Coral the person has quit at the
// next quiet install (#155). A --stop or the tray's own server child is not a start of Coral.
func startTakesInstallMark(stop, serverChild bool) bool {
	return !stop && !serverChild
}
