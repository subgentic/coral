//go:build windows

package mcpview

import "os"

// openNoBlock is os.Open here: Windows has no FIFO a path can name that blocks an open.
func openNoBlock(path string) (*os.File, error) { return os.Open(path) }
