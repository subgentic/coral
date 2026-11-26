package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/config"
)

func hubOnlyFlags(on, remote bool) *serverFlags {
	return &serverFlags{hubOnly: &on, remoteAccess: &remote}
}

// #21558: --hub-only is refused with a network --host or --remote, is saved, and stays on for a later start without the flag until `coral hub-only off`.
func TestApplyHubOnly(t *testing.T) {
	t.Cleanup(func() { auth.SetHubOnly(false) })
	cfg := &config.Config{Host: "0.0.0.0"}
	cfg.UseCoralDir(t.TempDir())
	err := applyHubOnly(cfg, hubOnlyFlags(true, false))
	require.Error(t, err, "--host 0.0.0.0 is refused in hub-only mode")
	assert.Contains(t, err.Error(), "0.0.0.0")
	assert.False(t, auth.HubOnly())
	assert.False(t, auth.HubOnlyPersisted(cfg.CoralDir()), "a refused start saves nothing")

	cfg = &config.Config{Host: "127.0.0.1"}
	cfg.UseCoralDir(t.TempDir())
	require.Error(t, applyHubOnly(cfg, hubOnlyFlags(true, true)), "--remote is refused too")

	require.NoError(t, applyHubOnly(cfg, hubOnlyFlags(true, false)))
	assert.True(t, auth.HubOnly())
	assert.True(t, auth.HubOnlyPersisted(cfg.CoralDir()), "the flag is saved")

	auth.SetHubOnly(false)
	require.NoError(t, applyHubOnly(cfg, hubOnlyFlags(false, false)))
	assert.True(t, auth.HubOnly(), "a later start without the flag stays hub-only")

	auth.SetHubOnly(false)
	require.NoError(t, auth.SetHubOnlyPersisted(cfg.CoralDir(), false))
	require.NoError(t, applyHubOnly(cfg, hubOnlyFlags(false, false)))
	assert.False(t, auth.HubOnly(), "off is off")
}

func TestRunHubOnly(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) (int, string, string) {
		var out, errb bytes.Buffer
		code := runHubOnly(append(args, "--home", dir), &out, &errb)
		return code, out.String(), errb.String()
	}
	code, out, _ := run("status")
	assert.Equal(t, 0, code)
	assert.Contains(t, out, "Hub-only is off")
	code, out, _ = run("on")
	assert.Equal(t, 0, code)
	assert.Contains(t, out, "Hub-only is on")
	code, out, _ = run("status")
	assert.Equal(t, 0, code)
	assert.Contains(t, out, "Hub-only is on")
	code, _, _ = run("off")
	assert.Equal(t, 0, code)
	assert.False(t, auth.HubOnlyPersisted(dir))
	code, _, errb := run("maybe")
	assert.Equal(t, 2, code)
	assert.Contains(t, errb, "usage: coral hub-only")
}
