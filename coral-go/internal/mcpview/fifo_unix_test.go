//go:build !windows

package mcpview

import (
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An agent can write its own folder: a FIFO named .mcp.json (or swapped in after a check) must not block the read for good (Security Reviewer's SHOULD on #9946).
func TestAFifoInPlaceOfAConfigFileIsNothingAndDoesNotBlock(t *testing.T) {
	home, folder := t.TempDir(), t.TempDir()
	require.NoError(t, syscall.Mkfifo(filepath.Join(folder, ".mcp.json"), 0o600))
	require.NoError(t, syscall.Mkfifo(filepath.Join(folder, ".gemini-fifo"), 0o600))
	done := make(chan Result, 1)
	go func() { done <- List(Env{Home: home}, "claude", folder) }()
	select {
	case res := <-done:
		assert.Empty(t, res.Servers, "a FIFO is not a configuration file")
	case <-time.After(5 * time.Second):
		t.Fatal("reading a FIFO blocked: the file must be opened without waiting and checked as opened")
	}
	require.NoError(t, syscall.Mkfifo(filepath.Join(home, ".claude.json"), 0o600))
	go func() { done <- List(Env{Home: home}, "claude", folder) }()
	select {
	case res := <-done:
		assert.Empty(t, res.Servers)
	case <-time.After(5 * time.Second):
		t.Fatal("a FIFO as the user file blocked")
	}
}
