//go:build windows

package peercred

import (
	"errors"
	"fmt"
	"log"
	"net/netip"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Supported reports whether this platform can tell the peer's user.
const Supported = true

const tcpTableOwnerPIDAll = 5 // TCP_TABLE_OWNER_PID_ALL

var (
	iphlpapi                = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTcpTable = iphlpapi.NewProc("GetExtendedTcpTable")
)

// ownerIsMe: the process owning the client socket runs as this process's user
// (the token user SIDs are equal).
func ownerIsMe(client, server netip.AddrPort, accepted time.Time) (bool, error) {
	pid, state, transitional, err := socketPID(client, server, !accepted.IsZero() && transitionalRowsOn())
	if err != nil {
		return false, err
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return false, fmt.Errorf("peercred: open process %d: %w", pid, err)
	}
	defer windows.CloseHandle(h)
	// A pid is not reused while a handle to its process is open: if the socket
	// still belongs to pid now, h is the process that owns it.
	if transitional {
		// The table reported the client's row in a transitional state (see ownerPIDTransitional): only a process that is still running and was created before the server
		// accepted the connection can be its owner, so a recycled pid in a stale row never counts.
		created, err := checkTransitionalOwner(h, accepted)
		if err != nil {
			return false, err
		}
		// Debug line, one per acceptance: the row's state and timing; no token, name or user data.
		log.Printf("[peercred] debug: counted a transitional socket row (state %d) as the client's: process %d created %v before the connection was accepted, lookup %v after it", state, pid, accepted.Sub(created).Round(time.Millisecond), time.Since(accepted).Round(time.Millisecond))
	}
	again, _, _, err := socketPID(client, server, !accepted.IsZero() && transitionalRowsOn()) // the row may have settled into ESTABLISHED meanwhile: the same pid either way
	if err != nil {
		return false, err
	}
	if again != pid {
		return false, errAmbiguous
	}
	var tok windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &tok); err != nil {
		return false, fmt.Errorf("peercred: open token of process %d: %w", pid, err)
	}
	defer tok.Close()
	theirs, err := tok.GetTokenUser()
	if err != nil {
		return false, err
	}
	mine, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return false, err
	}
	return theirs.User.Sid.Equals(mine.User.Sid), nil
}

// stillActive is GetExitCodeProcess's answer for a running process.
const stillActive = 259

// checkTransitionalOwner: the process behind a transitional row is running and was created before accepted.
func checkTransitionalOwner(h windows.Handle, accepted time.Time) (time.Time, error) {
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil || code != stillActive {
		return time.Time{}, fmt.Errorf("peercred: the process of a transitional socket row is not running: %w", ErrNotFound)
	}
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return time.Time{}, fmt.Errorf("peercred: process times: %w", err)
	}
	made := time.Unix(0, created.Nanoseconds())
	if !made.Before(accepted) {
		return time.Time{}, fmt.Errorf("peercred: the process of a transitional socket row was created after the connection was accepted: %w", ErrNotFound)
	}
	return made, nil
}

// transitionalRowsOn: counting a transitional socket row as the client's is on unless CORAL_PEERCRED_TRANSITIONAL=off, which falls back to failing closed (#385).
func transitionalRowsOn() bool { return os.Getenv("CORAL_PEERCRED_TRANSITIONAL") != "off" }

// socketPID reads the table of the client's address family. transitional is true when the owner came from a row in a transitional state (allowed only when allowTransitional,
// that is when the accept time is known).
func socketPID(client, server netip.AddrPort, allowTransitional bool) (pid, state uint32, transitional bool, err error) {
	family, v6 := uint32(windows.AF_INET), false
	if client.Addr().Is6() {
		family, v6 = windows.AF_INET6, true
	}
	b, err := tcpTable(family)
	if err != nil {
		return 0, 0, false, err
	}
	rows, err := parseTCPTable(b, v6)
	if err != nil {
		return 0, 0, false, err
	}
	pid, err = ownerPID(rows, client, server)
	if errors.Is(err, ErrNotFound) && allowTransitional {
		if p, st, terr := ownerPIDTransitional(rows, client, server); terr == nil {
			return p, st, true, nil
		} else if !errors.Is(terr, ErrNotFound) {
			return 0, 0, false, terr
		}
	}
	return pid, 0, false, err
}

func tcpTable(family uint32) ([]byte, error) {
	if err := procGetExtendedTcpTable.Find(); err != nil {
		return nil, err
	}
	size := uint32(16 << 10)
	for attempt := 0; attempt < 8; attempt++ { // the table can grow between calls
		buf := make([]byte, size)
		r, _, _ := procGetExtendedTcpTable.Call(
			uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)),
			0, uintptr(family), tcpTableOwnerPIDAll, 0)
		switch windows.Errno(r) {
		case windows.ERROR_SUCCESS:
			return buf, nil
		case windows.ERROR_INSUFFICIENT_BUFFER:
			size += 4 << 10
		default:
			return nil, fmt.Errorf("peercred: GetExtendedTcpTable: %w", windows.Errno(r))
		}
	}
	return nil, errors.New("peercred: GetExtendedTcpTable kept growing")
}
