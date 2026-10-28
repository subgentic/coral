//go:build !windows

package mcpview

import (
	"os"
	"syscall"
)

// openNoBlock opens path for reading without waiting for a writer: a FIFO opens at once (and is refused by the regular-file check), where a plain open would block for good.
func openNoBlock(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
