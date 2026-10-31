//go:build windows

package tcplisten

import (
	"encoding/binary"
	"errors"
	"net"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetExtendedTcpTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

const tcpTableOwnerPIDListener = 3 // TCP_TABLE_OWNER_PID_LISTENER

// Rows is the listener table of family af (AFInet or AFInet6).
func Rows(af uint32) ([]Row, error) {
	raw, err := table(af)
	if err != nil {
		return nil, err
	}
	var rows []Row
	if af == AFInet {
		for i := 0; i+24 <= len(raw); i += 24 { // MIB_TCPROW_OWNER_PID: state, localAddr, localPort, remoteAddr, remotePort, pid
			rows = append(rows, Row{
				Addr: net.IP(append([]byte(nil), raw[i+4:i+8]...)),
				Port: int(binary.BigEndian.Uint16(raw[i+8 : i+10])),
				PID:  binary.LittleEndian.Uint32(raw[i+20 : i+24]),
			})
		}
		return rows, nil
	}
	for i := 0; i+56 <= len(raw); i += 56 { // MIB_TCP6ROW_OWNER_PID: localAddr[16], scope, localPort, remoteAddr[16], scope, remotePort, state, pid
		rows = append(rows, Row{
			Addr: net.IP(append([]byte(nil), raw[i:i+16]...)),
			Port: int(binary.BigEndian.Uint16(raw[i+20 : i+22])),
			PID:  binary.LittleEndian.Uint32(raw[i+52 : i+56]),
		})
	}
	return rows, nil
}

// table is the listener table of family af, its rows as raw bytes (after the entry count).
func table(af uint32) ([]byte, error) {
	if af != AFInet && af != AFInet6 {
		return nil, errors.New("tcplisten: not an address family Rows takes")
	}
	var size uint32
	procGetExtendedTcpTable.Call(0, uintptr(unsafe.Pointer(&size)), 0, uintptr(af), tcpTableOwnerPIDListener, 0)
	for attempt := 0; attempt < 4; attempt++ {
		if size == 0 {
			size = 4096
		}
		buf := make([]byte, size)
		r, _, _ := procGetExtendedTcpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, uintptr(af), tcpTableOwnerPIDListener, 0)
		switch windows.Errno(r) {
		case 0:
			n := binary.LittleEndian.Uint32(buf[0:4])
			rowSize := uint32(24)
			if af == AFInet6 {
				rowSize = 56
			}
			end := 4 + n*rowSize
			if end > uint32(len(buf)) {
				end = uint32(len(buf))
			}
			return buf[4:end], nil
		case windows.ERROR_INSUFFICIENT_BUFFER:
			continue // the table grew: size now holds the new size
		default:
			return nil, windows.Errno(r)
		}
	}
	return nil, errors.New("GetExtendedTcpTable: the table kept growing")
}
