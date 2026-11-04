//go:build !windows

package ptymanager

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/tmux"
)

// Exercise Replay itself, including the empty/missing pipe-log fallback, rather
// than normalizing a test string in isolation. The fake tmux prints a styled
// capture snapshot; it never connects to a real tmux server.
func TestTmuxCaptureReplayStartsEachRowAtTheFirstColumn(t *testing.T) {
	for _, missing := range []bool{false, true} {
		name := "empty-log"
		if missing {
			name = "missing-log"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			fake := filepath.Join(dir, "tmux")
			require.NoError(t, os.WriteFile(fake, []byte("#!/bin/sh\nprintf '\\033[31mfirst line\\033[0m\\nsecond line\\nthird line\\n'\n"), 0700))
			log := filepath.Join(dir, "output.log")
			if !missing {
				require.NoError(t, os.WriteFile(log, nil, 0600))
			}
			b := &TmuxBackend{client: &tmux.Client{TmuxBin: fake, SocketPath: filepath.Join(dir, "isolated.sock")}, sessions: map[string]*tmuxSession{"agent": {logPath: log}}}
			got, err := b.Replay("agent")
			require.NoError(t, err)
			require.Equal(t, "\x1b[31mfirst line\x1b[0m\r\nsecond line\r\nthird line", string(got), "capture rows need CRLF for a stream terminal")
			stream := []byte("raw\nstream\r\n\x1b[2Cinput")
			require.NoError(t, os.WriteFile(log, stream, 0600))
			got, err = b.Replay("agent")
			require.NoError(t, err)
			require.Equal(t, stream, got, "an actual pipe-pane stream retains its original terminal controls")
		})
	}
}
