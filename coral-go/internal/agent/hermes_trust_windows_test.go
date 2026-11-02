//go:build windows

package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// Hermes on Windows has not been tried with Coral (#11715): no hook is installed, whatever tool is there. The tests of a prepared home (hermes_home_test.go) rely on this.
func TestHermesToolIsNeverTrustedOnWindows(t *testing.T) {
	r := hermesRig(t)
	assert.Error(t, hermesToolTrusted(hookToolFile(r.tools)))
	assert.Empty(t, hermesHookCommand("pre_llm_call"), "no hook command, so no hook entry")
}
