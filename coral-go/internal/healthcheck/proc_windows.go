//go:build windows

package healthcheck

import (
	"os/exec"

	"github.com/subgentic/coral/internal/executil"
)

func prepare(cmd *exec.Cmd) { executil.HideWindow(cmd) }

// killGroup ends the script's whole tree (executil walks it).
func killGroup(cmd *exec.Cmd) { _ = executil.Kill(cmd) }

func linkCount(interface{ Sys() any }) uint64 { return 1 }
