package main

// The apply's switch, per platform (#5879). macOS is ON (#7325, the operator's "release the auto-installer", 2026-10-24): its live install passed on an isolated copy, a real 1.4.161 app updated to the
// operator's promotion of 1.4.162 by the product's own apply (the real hdiutil, ditto, codesign and Team ID pin, the atomic swap, the new server started and answering, the signature valid afterwards).
// Windows is OFF until its own stage-2 live install passes (#7320: Windows Installer, the signed MSI), then a one-line change of its constant below, reviewed as such; Linux is OFF until the rehearsal
// workflow is green again (the install-layout fix, #7327). Windows's constant counts only once windowsApplyBuilt is true, set together with the real apply: the MSI major upgrade (#162, apply.RunMSI
// with apply.WindowsMSI, run by runApplyWindows).
const (
	applyEnabledDarwin  = true
	applyEnabledLinux   = false
	applyEnabledWindows = false

	windowsApplyBuilt = true
)

// applyOn is the switch of goos: its own constant, and for Windows also the proof that its apply exists. Any other OS has no apply.
func applyOn(goos string, darwin, linux, windows, windowsBuilt bool) bool {
	switch goos {
	case "darwin":
		return darwin
	case "linux":
		return linux
	case "windows":
		return windows && windowsBuilt
	}
	return false
}
