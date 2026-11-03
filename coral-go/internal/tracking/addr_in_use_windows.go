//go:build windows

package tracking

import "syscall"

// WSAEADDRINUSE: Windows' own "address already in use", which a listen returns there.
func init() { addrInUse = append(addrInUse, syscall.EADDRINUSE, syscall.Errno(10048)) }
