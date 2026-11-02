package agent

import (
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A cloud machine is Linux whatever the Coral that builds its setup runs on: CLIInfoOn("linux") is agy's bash installer, and Windows' own command is not (#12428: a Windows Coral's builder read the Windows one and refused the machine).
func TestCLIInfoOnAnotherOS(t *testing.T) {
	linux, windows := CLIInfoOn("linux", "agy"), CLIInfoOn("windows", "agy")
	require.NotNil(t, linux)
	require.NotNil(t, windows)
	assert.True(t, strings.HasPrefix(linux.InstallCommand, "curl -fsSL ") && strings.HasSuffix(linux.InstallCommand, " | bash"), "agy on Linux: %q", linux.InstallCommand)
	assert.NotEqual(t, linux.InstallCommand, windows.InstallCommand, "Windows has its own")
	assert.Equal(t, GetCLIInfo("claude").InstallCommand, CLIInfoOn(runtime.GOOS, "claude").InstallCommand)
}
