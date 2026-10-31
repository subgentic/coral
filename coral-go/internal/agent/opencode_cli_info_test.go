package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

func TestOpencodeHasACLIThePickerCanCheckAndInstall(t *testing.T) {
	info := GetCLIInfo(at.Opencode)
	require.NotNil(t, info)
	assert.Equal(t, "opencode", info.Binary)
	assert.NotEmpty(t, info.InstallCommand)
	assert.Equal(t, "https://opencode.ai", info.InstallURL)
}
