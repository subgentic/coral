package opencode

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAnAgentsNewestSessionIsRecordedForAWakeAndOnlyAValidOneIsRead(t *testing.T) {
	cfg, _ := stubConfig(t)
	assert.Equal(t, "", StoredSession(cfg.DataDir, "agent-1"))
	m := NewManager(cfg)
	defer m.Close()
	_, err := m.Ensure(context.Background(), "agent-1", "", "", "")
	require.NoError(t, err)
	m.UseSession("agent-1", "ses_first")
	assert.Equal(t, "ses_first", m.StoredSession("agent-1"))
	m.UseSession("agent-1", "ses_second")
	assert.Equal(t, "ses_second", m.StoredSession("agent-1"), "the newest")
	assert.Equal(t, "", m.StoredSession("agent-2"))
	assert.Equal(t, "", m.StoredSession("../agent-1"), "a key that is not one reads nothing")

	require.NoError(t, os.WriteFile(filepath.Join(agentsDir(cfg.DataDir), "agent-3"), []byte("../../etc/passwd"), 0o600))
	assert.Equal(t, "", m.StoredSession("agent-3"), "a record that is not a session id is not followed")
}
