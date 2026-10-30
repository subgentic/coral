package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
)

// --port 0 is "any free port", not "not given": it must not fall back to the default port (8450 on Windows is the live Coral's).
func TestAnExplicitPortZeroIsAnyFreePortAndNotTheDefault(t *testing.T) {
	cfg := config.Load(t.TempDir())
	def := cfg.Port
	require.NotZero(t, def, "the default port is not 0")

	require.NoError(t, applyPortFlag(cfg, 0, false))
	assert.Equal(t, def, cfg.Port, "no --port: the default stays")

	require.NoError(t, applyPortFlag(cfg, 0, true))
	assert.Zero(t, cfg.Port, "--port 0 reaches Start as 0, which binds any free port and reports it")

	require.NoError(t, applyPortFlag(cfg, 9123, true))
	assert.Equal(t, 9123, cfg.Port)
	require.NoError(t, applyPortFlag(cfg, 65535, true))
	assert.Equal(t, 65535, cfg.Port)

	cfg.Port = def
	for _, bad := range []int{-1, 65536, 70000, -8450} {
		assert.Error(t, applyPortFlag(cfg, bad, true), "%d", bad)
		assert.Equal(t, def, cfg.Port, "a refused port changes nothing")
	}
}
