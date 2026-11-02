//go:build darwin

package peercred

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Supported reports whether this platform can tell the peer's user.
const Supported = true

// ownerIsMe: the client socket's so_uid in the kernel's TCP table is this
// process's. A process signed the usual way is shown a table without the other processes' sockets
// (macOS 27, #12529): then the client's socket is looked for among this user's own processes through
// libproc, and found there means this user's.
func ownerIsMe(client, server netip.AddrPort, _ time.Time) (bool, error) {
	b, err := unix.SysctlRaw("net.inet.tcp.pcblist_n")
	if err != nil {
		return false, err
	}
	uid, err := parsePCBList(b, client, server, hostLittleEndian)
	if errors.Is(err, errHidden) {
		return ownedByMyProcess(client, server)
	}
	if err != nil {
		return false, err
	}
	return uid == os.Geteuid(), nil
}

// proc_info (syscall 336) is what libproc's proc_listpids, proc_pidinfo and proc_pidfdinfo call: the
// same thing without cgo, which the releases are built without.
const (
	sysProcInfo         = 336
	procInfoCallPidInfo = 2
	procInfoCallFdInfo  = 3
	procPidListFds      = 1 // PROC_PIDLISTFDS: {i32 fd, u32 type} per descriptor
	procPidFdSocketInfo = 3 // PROC_PIDFDSOCKETINFO
	fdTypeSocket        = 2 // PROX_FDTYPE_SOCKET
)

func procInfo(call, pid, flavor int, arg uint64, buf []byte) (int, error) {
	var p unsafe.Pointer
	if len(buf) > 0 {
		p = unsafe.Pointer(&buf[0])
	}
	r, _, e := unix.Syscall6(sysProcInfo, uintptr(call), uintptr(pid), uintptr(flavor), uintptr(arg), uintptr(p), uintptr(len(buf)))
	if e != 0 {
		return -1, e
	}
	return int(r), nil
}

// mySockets calls visit with the two ends of every TCP socket of this user's processes, until visit returns true (a test seam: the real list is libproc's).
var mySockets = libprocSockets

// ownedByMyProcess reports whether a process of this user holds the socket whose local end is client and whose remote end is server. Only this user's processes are asked (the kernel
// answers for no others), so a client that is another user's, or is nobody's, is not found: ErrNotFound, refused as another user's, as before. If the server's own end of the connection
// is not seen either, libproc cannot be trusted to have shown the sockets at all (a layout this build does not read): the layout answer, never "not found".
func ownedByMyProcess(client, server netip.AddrPort) (bool, error) {
	found, sawOwn := false, false
	if err := mySockets(func(local, remote netip.AddrPort) bool {
		local, remote = unmap(local), unmap(remote)
		if local == client && remote == server {
			found = true
		}
		if local == server && remote == client {
			sawOwn = true
		}
		return found
	}); err != nil {
		return false, err
	}
	if found {
		return true, nil
	}
	if !sawOwn {
		return false, fmt.Errorf("%w: libproc shows no socket of this connection, not even the server's", ErrLayout)
	}
	return false, ErrNotFound
}

// libprocSockets is mySockets by proc_info. A process that exits mid-read is skipped.
func libprocSockets(visit func(local, remote netip.AddrPort) bool) error {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.uid", os.Geteuid())
	if err != nil {
		return err
	}
	sock := make([]byte, sockFdinfoSize)
	for _, kp := range procs {
		pid := int(kp.Proc.P_pid)
		n, err := procInfo(procInfoCallPidInfo, pid, procPidListFds, 0, nil)
		if err != nil || n <= 0 {
			continue
		}
		fds := make([]byte, n+64) // descriptors opened since the size was read
		if n, err = procInfo(procInfoCallPidInfo, pid, procPidListFds, 0, fds); err != nil {
			continue
		}
		for off := 0; off+8 <= n; off += 8 {
			if binary.LittleEndian.Uint32(fds[off+4:]) != fdTypeSocket {
				continue
			}
			fd := uint64(binary.LittleEndian.Uint32(fds[off:]))
			m, err := procInfo(procInfoCallFdInfo, pid, procPidFdSocketInfo, fd, sock)
			if err != nil || m < len(sock) {
				continue
			}
			if local, remote, ok := parseSocketFdinfo(sock); ok && visit(local, remote) {
				return nil
			}
		}
	}
	return nil
}

// relayOwner: WSL's localhost relay is a Linux kernel's socket owner; nothing here is one.
func relayOwner(client, server netip.AddrPort) bool { return false }
