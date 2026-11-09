package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCompactContextIsOffByDefaultWithA200kThresholdAndIsClamped(t *testing.T) {
	d := DefaultHealthSettings().CompactContext
	assert.False(t, d.On)
	assert.Equal(t, 200, d.ThresholdK)
	assert.False(t, d.Orchestrator)
	h := DefaultHealthSettings()
	h.CompactContext.ThresholdK = 0
	assert.Equal(t, 200, h.Clamp().CompactContext.ThresholdK, "a body that does not carry it is the default")
	h.CompactContext.ThresholdK = 10
	assert.Equal(t, 50, h.Clamp().CompactContext.ThresholdK)
	h.CompactContext.ThresholdK = 5000
	assert.Equal(t, 900, h.Clamp().CompactContext.ThresholdK)
}

func TestCompactContextIsStoredPerTeam(t *testing.T) {
	s, err := NewStoreWithKey(filepath.Join(t.TempDir(), "b.db"), "")
	require.NoError(t, err)
	defer s.Close()
	ctx := context.Background()
	h := DefaultHealthSettings()
	h.CompactContext = HealthCompact{On: true, ThresholdK: 300, Orchestrator: true}
	require.NoError(t, s.SetHealthSettings(ctx, "a", h))
	assert.Equal(t, HealthCompact{On: true, ThresholdK: 300, Orchestrator: true}, s.GetHealthSettings(ctx, "a").CompactContext)
	assert.False(t, s.GetHealthSettings(ctx, "b").CompactContext.On, "another team keeps the default")
}
