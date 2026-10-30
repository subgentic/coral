package testguard_test

import (
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/testguard"
)

// The guard refuses the live Coral's default port on every OS. It once held 8420 only, so on Windows (config.DefaultPort 8450) it never refused the live Coral.
func TestTheDefaultPortsIncludeEveryPlatformsDefault(t *testing.T) {
	ports := testguard.DefaultPorts()
	assert.Contains(t, ports, strconv.Itoa(config.DefaultPort), "this platform's default port")
	assert.Contains(t, ports, "8420", "the Unix default, on every OS")
	assert.Contains(t, ports, "8450", "the Windows default, on every OS")
}
