package main

// The apply's switch, per platform (#5879). macOS is ON (#7325, the operator's "release the auto-installer", 2026-10-24): its live install passed on an isolated copy, a real 1.4.161 app updated to the
// operator's promotion of 1.4.162 by the product's own apply (the real hdiutil, ditto, codesign and Team ID pin, the atomic swap, the new server started and answering, the signature valid afterwards).
// Windows is ON too (#7320, run 40132602190, QA approved): a real 1.4.161 MSI went to the promoted 1.4.162 through the real apply; off, no click, a stale click and a tampered package were all refused, and 1.4.166 never
// downgraded. Its package is not Authenticode-signed yet (accepted on checksums and the Sigstore bundle), a portable copy never updates (MSI installs only), and a rollback package is kept only when the installed version was
// itself promoted. Linux is OFF until the rehearsal workflow is green again (the install-layout fix, #7327). Windows's constant counts only once windowsApplyBuilt is true, set together with the real apply: the MSI major upgrade (#162, apply.RunMSI
// with apply.WindowsMSI, run by runApplyWindows).
const (
	applyEnabledDarwin  = true
	applyEnabledLinux   = false
	applyEnabledWindows = true

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
