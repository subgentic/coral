//go:build windows

package main

import "os/exec"

// heavyOwnGroup: on Windows the command is stopped by the context alone.
func heavyOwnGroup(c *exec.Cmd) {}

// heavyUnsupportedHere: the heavy pool is this machine and a remote one. A run stops its command by killing its whole process group, which Windows has no equivalent of here: a stopped run would leave what the
// shell started running beside the next agent's. So it says so at once and does not start (#13820).
func heavyUnsupportedHere() string {
	return "coral-board heavy run does not run on Windows: heavy runs are for a Mac or Linux machine and the remote machines of its pool. Run the command here directly, or from a Mac or Linux checkout."
}
