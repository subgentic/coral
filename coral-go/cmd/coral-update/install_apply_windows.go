//go:build windows

package main

import (
	"os"
	"time"

	"github.com/subgentic/coral/internal/updater/status"
)

func init() { applyProbe = probeForApply }

// selfExe is the path of this program (a variable so a test can say).
var selfExe = func() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return exe
}

// probeForApply is probeInstall for an apply run: the same answer, except that the dashboard's copy of the registered updater (copyOfTheRegisteredUpdater) is judged as the
// registered install it was copied from, so a portable_install answer is kept for every other program.
func probeForApply(dataDir string) *status.Install {
	i := installProbe()
	if i == nil || i.Unsupported != "portable_install" {
		return i
	}
	m := newWindowsMSI("")
	reg, err := m.Install()
	if err != nil || m.Unsupported(reg) != "" {
		return i
	}
	if copyOfTheRegisteredUpdater(reg, dataDir, selfExe(), time.Now()) {
		return &status.Install{Kind: "msi", Writable: true}
	}
	return i
}
