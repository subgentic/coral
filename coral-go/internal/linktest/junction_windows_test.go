//go:build windows

package linktest

import (
	"errors"
	"syscall"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestARunnerThatRefusesJunctionsFailsOnCIAndOnlyThere(t *testing.T) {
	err := refusedOnCI("true", false)
	if assert.Error(t, err) {
		assert.Contains(t, err.Error(), "CI no longer exercises Coral's junction layer")
	}
	assert.NoError(t, refusedOnCI("", false), "locally it is a logged either/or")
	assert.NoError(t, refusedOnCI("true", true), "a runner that follows junctions is fine")
	assert.NoError(t, refusedOnCI("", true))
}

func TestUntrustedMountPointIsTheSystemsRefusalOnly(t *testing.T) {
	assert.True(t, UntrustedMountPoint(errors.Join(errors.New("open x"), errUntrustedMountPoint)))
	assert.False(t, UntrustedMountPoint(syscall.ERROR_FILE_NOT_FOUND))
	assert.False(t, UntrustedMountPoint(nil))
}
