package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
)

// `coral machine` is off by default (#9934 slice 1b): with the flag unset it is not dispatched, not in the help and not found by `coral help machine`.
func TestMachineIsOffByDefault(t *testing.T) {
	t.Setenv(machineLaunchEnvVar, "")
	for _, args := range [][]string{{"machine"}, {"machine", "launch"}, {"machine", "list"}, {"machine", "delete", "x"}, {"machine", "prune"}, {"machine", "egress-files"}} {
		_, ok := subcommand(args)
		assert.False(t, ok, "%v must not be a command while the flag is off", args)
	}
	var out bytes.Buffer
	printHelp(&out)
	assert.NotContains(t, out.String(), "  machine ")
	assert.False(t, printCommandHelp(&out, "machine"))
	_, found := findCommand("machine")
	assert.False(t, found)
}

func TestMachineIsOnWithTheFlag(t *testing.T) {
	for _, v := range []string{"0", "false", "off", "no", "garbage"} {
		t.Setenv(machineLaunchEnvVar, v)
		_, ok := subcommand([]string{"machine"})
		assert.False(t, ok, "%q is not on", v)
	}
	t.Setenv(machineLaunchEnvVar, "1")
	code, ok := subcommand([]string{"machine"}) // no subcommand: the usage, exit 2, and nothing reaches a provider
	assert.True(t, ok)
	assert.Equal(t, 2, code)
	var out bytes.Buffer
	printHelp(&out)
	assert.Contains(t, out.String(), "  machine ")
}
