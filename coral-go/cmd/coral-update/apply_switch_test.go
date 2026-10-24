package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #5879, #7325: the apply is switched per platform. macOS is on, after its live install passed (an isolated 1.4.161 updated to the promoted 1.4.162 by the product's own apply); Linux and Windows are off
// until theirs have passed (#7327's rehearsal fix, #7320's Windows live install), each a change of its own.
func TestOnlyTheMacApplyIsOn(t *testing.T) {
	assert.True(t, applyEnabledDarwin, "macOS: its live install passed (#7325)")
	assert.False(t, applyEnabledLinux, "Linux stays off until the rehearsal is green again (#7327)")
	assert.False(t, applyEnabledWindows, "Windows stays off until its live install passes (#7320)")
	assert.True(t, windowsApplyBuilt, "the Windows apply exists (#162), and stays off by applyEnabledWindows")
	want := map[string]bool{"darwin": true, "linux": false, "windows": false, "freebsd": false}
	for goos, on := range want {
		assert.Equal(t, on, applyOn(goos, applyEnabledDarwin, applyEnabledLinux, applyEnabledWindows, windowsApplyBuilt), goos)
	}
	assert.Equal(t, runtime.GOOS == "darwin", applyEnabled, "the switch this build reads is the one of the platform it runs on")
}

func TestEachPlatformReadsItsOwnSwitch(t *testing.T) {
	assert.True(t, applyOn("darwin", true, false, false, false))
	assert.False(t, applyOn("darwin", false, true, true, true), "Linux's and Windows's do not turn Mac on")
	assert.True(t, applyOn("linux", false, true, false, false))
	assert.False(t, applyOn("linux", true, false, true, true))
	assert.False(t, applyOn("plan9", true, true, true, true), "an OS with no apply")
}

// Windows cannot be turned on before its apply exists: the constant alone is refused.
func TestWindowsIsRefusedEvenIfItsSwitchIsFlipped(t *testing.T) {
	assert.False(t, applyOn("windows", true, true, true, false))
	assert.True(t, applyOn("windows", false, false, true, true), "only with its apply built")
}

// windowsApplyBuilt may be true only when the Windows apply is real: the MSI major upgrade (#162), apply.RunMSI over Windows Installer
// (apply.WindowsMSI), is what coral-update's Windows apply runs. (pid_windows.go's stubs are the macOS/Linux swap apply's, which Windows
// never takes.)
func TestWindowsApplyBuiltNeedsARealWindowsApply(t *testing.T) {
	raw, err := os.ReadFile("apply_windows.go")
	require.NoError(t, err)
	real := strings.Contains(string(raw), "apply.RunMSI(") && strings.Contains(string(raw), "&apply.WindowsMSI{")
	_, statErr := os.Stat(filepath.Join("..", "..", "internal", "updater", "apply", "apply_msi.go"))
	if windowsApplyBuilt || applyEnabledWindows {
		assert.True(t, real && statErr == nil, "the Windows apply must be the MSI one before Windows can be switched on")
	}
}
