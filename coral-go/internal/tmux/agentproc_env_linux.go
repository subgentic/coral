//go:build linux

package tmux

import (
	"bytes"
	"fmt"
	"os"
)

// procEnvHasSession: the process's environment (the same user's only; /proc refuses another's) carries CORAL_SESSION_NAME=<session>. False when it cannot be read.
func procEnvHasSession(pid int, session string) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
	if err != nil {
		return false
	}
	want := []byte("CORAL_SESSION_NAME=" + session)
	for _, kv := range bytes.Split(b, []byte{0}) {
		if bytes.Equal(kv, want) {
			return true
		}
	}
	return false
}
