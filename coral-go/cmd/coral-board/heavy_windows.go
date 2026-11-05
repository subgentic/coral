//go:build windows

package main

import "os/exec"

// heavyOwnGroup: on Windows the command is stopped by the context alone.
func heavyOwnGroup(c *exec.Cmd) {}
