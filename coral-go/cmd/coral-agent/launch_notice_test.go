package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #14353: coral-agent launch prints the mode the agent started in, where to lower it and, until the owner has read it, the notice; an older server's answer prints nothing extra.
func TestLaunchPrintsTheModeHowToLowerItAndTheNotice(t *testing.T) {
	var out bytes.Buffer
	printLaunchNotice(&out, map[string]any{"permission_mode": "auto", "permission_lowering": "To lower it: pass a lower mode.",
		"launch_disclosure": map[string]any{"id": "x", "text": "Agents you start here begin with full permissions."}})
	assert.Contains(t, out.String(), "Permission mode: auto")
	assert.Contains(t, out.String(), "To lower it: pass a lower mode.")
	assert.Contains(t, out.String(), "Notice: Agents you start here begin with full permissions.")
	out.Reset()
	printLaunchNotice(&out, map[string]any{"session_name": "s"})
	assert.Empty(t, out.String(), "an older server")
}
