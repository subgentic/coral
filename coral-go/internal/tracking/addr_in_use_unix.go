//go:build !windows

package tracking

import "syscall"

func init() { addrInUse = append(addrInUse, syscall.EADDRINUSE) }
