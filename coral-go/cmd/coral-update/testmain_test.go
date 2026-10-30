package main

import (
	"os"
	"testing"
)

// A test binary never starts the person's installed Coral. restart_windows.go's init makes startCoralFrom the real WindowsMSI.Start and
// registeredInstall the real lookup of the product Windows Installer registered, so a test that wrote a click marker without a folder and let
// runApply restart Coral started C:\Program Files\Coral\coral-tray.exe on the desktop of whoever ran the tests (QA's ten extra trays on the live
// port). Here, before any test, both become calls that stop the run: a test starts Coral only through its own fake (fakeStart, registered).
func TestMain(m *testing.M) {
	startCoralFrom = func(dataDir, dir string) error {
		panic("a test reached the real start of Coral (coral-tray.exe from " + dir + "): replace startCoralFrom with fakeStart")
	}
	registeredInstall = func() (string, error) {
		panic("a test reached the lookup of the registered Coral install: replace registeredInstall with registered(t, dir, err)")
	}
	os.Exit(m.Run())
}
