//go:build dev

package main

import (
	"context"
	"os"
	"os/exec"

	"github.com/subgentic/coral/internal/heavy"
)

// heavyTransportOverride exists only in a dev build, for trying the wrapper on a machine whose account is not the restricted one: CORAL_HEAVY_TEST_DEST is an ssh destination and CORAL_HEAVY_TEST_REMOTE the wrapper's path
// there (given as the remote command, which a forced command would ignore). A product build has no such door.
func heavyTransportOverride() (heavy.Transport, bool) {
	dest, remote := os.Getenv("CORAL_HEAVY_TEST_DEST"), os.Getenv("CORAL_HEAVY_TEST_REMOTE")
	if dest == "" || remote == "" {
		return nil, false
	}
	args, err := heavy.SSHArgs(dest)
	if err != nil {
		return nil, false
	}
	args = append(args, remote)
	return func(ctx context.Context) (heavy.Conn, error) {
		cmd := exec.CommandContext(ctx, "ssh", args...)
		in, err := cmd.StdinPipe()
		if err != nil {
			return heavy.Conn{}, err
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			return heavy.Conn{}, err
		}
		er, err := cmd.StderrPipe()
		if err != nil {
			return heavy.Conn{}, err
		}
		if err := cmd.Start(); err != nil {
			return heavy.Conn{}, err
		}
		return heavy.Conn{Stdin: in, Stdout: out, Stderr: er, Wait: cmd.Wait}, nil
	}, true
}
