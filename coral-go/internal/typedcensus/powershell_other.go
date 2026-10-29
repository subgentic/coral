//go:build !windows

package typedcensus

import "testing"

// checkPowerShell is the PowerShell parse check, which runs where PowerShell is the agents' shell (Windows).
func checkPowerShell(t *testing.T, _ []Case) {
	t.Helper()
	t.Log("not Windows: the PowerShell parse check is skipped")
}
