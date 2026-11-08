//go:build windows

package hooks

import (
	"encoding/binary"
	"errors"
	"fmt"
	"github.com/subgentic/coral/internal/winuser"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/agentenv"
	"github.com/subgentic/coral/internal/cliauth"
)

var procGetExtendedTcpTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

const (
	tcpTableOwnerPIDListener = 3 // TCP_TABLE_OWNER_PID_LISTENER
	tcpTableOwnerPIDAll      = 5 // TCP_TABLE_OWNER_PID_ALL
	tcpStateEstablished      = 5
	afInet                   = 2
	afInet6                  = 23
)

// listenerPIDs, pidOwner, coralFolders, tcpRows, selfSID and fileOwner are the system lookups; a test replaces them.
var (
	listenerPIDs = tcpListenerPIDs
	pidOwner     = processOwner
	coralFolders = allowedCoralFolders
	tcpRows      = tcpListeners
	selfSID      = winuser.CurrentSID
	fileOwner    = fileOwnerSID
	// connectionOwnerPID connects to host:port and says which process owns the server end of that connection (connected false: nothing accepted it); a test replaces it.
	connectionOwnerPID = connectionOwner
)

// checkListener: the process that would receive a connection to host:port is Coral's (#224 B): its token's user is this user's
// SID, and its image is coral.exe or coral-tray.exe in a folder Coral runs from (the running tool's own folder, which covers a
// dev build and the installed tools, or the Coral install under Program Files). No listener at all is fine (the connection
// fails by itself). Anything else, or a listener whose owner can't be read, fails closed with a reason.
func checkListener(host string, port int) error {
	owners, err := allowedOwners()
	if err != nil {
		return fmt.Errorf("coral: can't read this user's account to check Coral's port %d: %w", port, err)
	}
	pids, err := listenerPIDs(host, port)
	if err != nil {
		return fmt.Errorf("coral: can't list what listens on port %d to check it is Coral: %w", port, err)
	}
	if len(pids) == 0 {
		// The listener table can miss a listener that is there (it showed a new one's row about three times in twenty): a missing row is not "nothing is there". Where the connection is accepted anyway, the
		// owner of its server end is checked like a listener's; where it is not, there is nothing and the connection fails by itself.
		pid, connected, cerr := connectionOwnerPID(host, port)
		if !connected {
			return nil
		}
		if cerr != nil {
			return &ForeignListenerError{Port: port, Why: fmt.Sprintf("Coral couldn't check who runs the program on that port: %v. Check what is listening on port %d, or start Coral.", cerr, port)}
		}
		pids = []uint32{pid}
	}
	self := uint32(os.Getpid())
	for _, pid := range pids {
		if AllowTestServerListener && pid == self {
			continue // a test's in-process server (tests only)
		}
		sid, image, err := pidOwner(pid)
		if err != nil {
			// Not "stop that program": a check that fails on Coral's own process would tell the person to stop their Coral (Security, #280).
			return &ForeignListenerError{Port: port, PID: pid, Why: fmt.Sprintf("Coral couldn't check who runs the program on that port (PID %d): %v. "+
				"Check what is listening on port %d, or start Coral.", pid, err, port)}
		}
		if !ownedByOneOf(sid, owners) {
			who := "another account"
			if sid != nil {
				who = "another account (" + sid.String() + ")"
			}
			return &ForeignListenerError{Port: port, PID: pid, Why: fmt.Sprintf("The program on that port (PID %d) runs as %s, not as you or the owner of Coral's data folder. "+
				"Start Coral as yourself, or stop that program.", pid, who)}
		}
		if !isCoralImage(image, coralFolders()) && !(AllowTestServerListener && sameExecutable(image)) {
			return &ForeignListenerError{Port: port, PID: pid, Why: fmt.Sprintf("The program on that port is %s (PID %d), not Coral's coral.exe or coral-tray.exe. "+
				"Start Coral, or stop the program that holds its port. If it is your own dev or test build of Coral, build coral-agent and the hooks "+
				"into the folder of its coral.exe ('make dev' does), so this tool sits beside it.", image, pid)}
		}
	}
	return nil
}

// sameExecutable: image is this tool's own executable file (see AllowTestServerListener).
func sameExecutable(image string) bool {
	exe, err := os.Executable()
	if err != nil || image == "" {
		return false
	}
	// Windows may report the listener through a DOS 8.3 path while this
	// executable resolves to its long path. Compare file identity so aliases
	// pass only when they refer to this exact test executable.
	self, err := os.Stat(exe)
	if err != nil {
		return false
	}
	other, err := os.Stat(image)
	return err == nil && os.SameFile(self, other)
}

// isCoralImage: image is coral.exe or coral-tray.exe directly in one of folders.
func isCoralImage(image string, folders []string) bool {
	if image == "" {
		return false
	}
	if base := strings.ToLower(filepath.Base(image)); base != "coral.exe" && base != "coral-tray.exe" {
		return false
	}
	dir := filepath.Clean(filepath.Dir(image))
	for _, f := range folders {
		if f != "" && strings.EqualFold(dir, filepath.Clean(f)) {
			return true
		}
	}
	return false
}

// allowedCoralFolders: where Coral's server runs from. The running tool's own folder (coral-board and the hooks sit beside
// coral.exe and coral-tray.exe in the install, and in a dev build's output folder), and the Coral install under the Program Files
// folders (both the x64 and the x86 one: the release MSI was x86 until #93).
func allowedCoralFolders() []string {
	var out []string
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		out = append(out, filepath.Dir(exe))
	}
	// The Program Files folders from the system (as the updater reads them), never from %ProgramFiles%, which the environment sets.
	for _, id := range []*windows.KNOWNFOLDERID{windows.FOLDERID_ProgramFiles, windows.FOLDERID_ProgramFilesX86} {
		if p, err := windows.KnownFolderPath(id, 0); err == nil && p != "" {
			out = append(out, filepath.Join(p, "Coral"))
		}
	}
	return out
}

// allowedOwners: the accounts Coral's server may run as, for this tool. This user, and the owner of the session's token file and
// of Coral's data folder: a tool started inside a sandbox that runs commands as another local account (Codex's elevated
// Windows sandbox) has another SID than the user running Coral, whose data folder and token file are the user's (Security's
// note on #224). A well-known service or group owner (SYSTEM, LocalService, NetworkService, Administrators) is never added:
// those are not one person's Coral, and a service such as the one this computer has on 8420 runs as one of them.
func allowedOwners() ([]*windows.SID, error) {
	me, err := selfSID()
	if err != nil {
		return nil, err
	}
	owners := []*windows.SID{me}
	paths := []string{cliauth.DataDir()}
	if p := strings.TrimSpace(os.Getenv(agentenv.SessionAuthFileEnv)); p != "" {
		paths = append(paths, p)
	}
	for _, p := range paths {
		if sid, err := fileOwner(p); err == nil && sid != nil && isPersonSID(sid) && !ownedByOneOf(sid, owners) {
			owners = append(owners, sid)
		}
	}
	return owners, nil
}

// isPersonSID: sid is not a well-known service or group account.
func isPersonSID(sid *windows.SID) bool {
	for _, wk := range []windows.WELL_KNOWN_SID_TYPE{windows.WinLocalSystemSid, windows.WinLocalServiceSid, windows.WinNetworkServiceSid, windows.WinBuiltinAdministratorsSid, windows.WinBuiltinUsersSid, windows.WinWorldSid, windows.WinAuthenticatedUserSid} {
		if sid.IsWellKnown(wk) {
			return false
		}
	}
	return true
}

func ownedByOneOf(sid *windows.SID, owners []*windows.SID) bool {
	if sid == nil {
		return false
	}
	for _, o := range owners {
		if sid.Equals(o) {
			return true
		}
	}
	return false
}

// fileOwnerSID is the owner of the file or folder at path.
func fileOwnerSID(path string) (*windows.SID, error) {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return nil, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return nil, err
	}
	return owner.Copy()
}

// processOwner is pid's user SID and image path.
func processOwner(pid uint32) (*windows.SID, string, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return nil, "", err
	}
	defer windows.CloseHandle(h)
	var tok windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &tok); err != nil {
		return nil, "", err
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return nil, "", err
	}
	sid, err := u.User.Sid.Copy()
	if err != nil {
		return nil, "", err
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	image := ""
	if windows.QueryFullProcessImageName(h, 0, &buf[0], &n) == nil {
		image = windows.UTF16ToString(buf[:n])
	}
	return sid, image, nil
}

// listenRow is one TCP listener: its local address, port and process.
type listenRow struct {
	addr net.IP
	port int
	pid  uint32
}

// winningPIDs: the processes a connection to ip:port would reach. A listener on ip itself wins over one on its family's
// wildcard (0.0.0.0 or ::), the more specific address taking the connection (the Security Reviewer's #224 finding), so when
// both exist only the specific one is returned: that is the one to check.
func winningPIDs(rows []listenRow, ip net.IP, port int) []uint32 {
	wildcard := net.IPv4zero
	if ip.To4() == nil {
		wildcard = net.IPv6unspecified
	}
	var exact, wild []uint32
	for _, r := range rows {
		if r.port != port {
			continue
		}
		switch {
		case r.addr.Equal(ip):
			exact = append(exact, r.pid)
		case r.addr.Equal(wildcard):
			wild = append(wild, r.pid)
		}
	}
	if len(exact) > 0 {
		return exact
	}
	return wild
}

// tcpListenerPIDs: the processes a connection to host:port would reach, per address family. "localhost" is both 127.0.0.1 and
// ::1, and each family's winner is returned.
func tcpListenerPIDs(host string, port int) ([]uint32, error) {
	var want []net.IP
	if strings.EqualFold(host, "localhost") {
		want = []net.IP{net.IPv4(127, 0, 0, 1).To4(), net.IPv6loopback}
	} else if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			ip = ip4
		}
		want = []net.IP{ip}
	} else {
		return nil, errors.New("not an IP address: " + host)
	}
	seen := map[uint32]bool{}
	var pids []uint32
	for _, ip := range want {
		af := uint32(afInet6)
		if ip.To4() != nil {
			af = afInet
		}
		rows, err := tcpRows(af)
		if err != nil {
			return nil, err
		}
		for _, pid := range winningPIDs(rows, ip, port) {
			if !seen[pid] {
				seen[pid] = true
				pids = append(pids, pid)
			}
		}
	}
	return pids, nil
}

// tcpListeners is the listener table of family af.
func tcpListeners(af uint32) ([]listenRow, error) {
	raw, err := tcpTable(af)
	if err != nil {
		return nil, err
	}
	var rows []listenRow
	if af == afInet {
		for i := 0; i+24 <= len(raw); i += 24 { // MIB_TCPROW_OWNER_PID: state, localAddr, localPort, remoteAddr, remotePort, pid
			rows = append(rows, listenRow{
				addr: net.IP(append([]byte(nil), raw[i+4:i+8]...)),
				port: int(binary.BigEndian.Uint16(raw[i+8 : i+10])),
				pid:  binary.LittleEndian.Uint32(raw[i+20 : i+24]),
			})
		}
		return rows, nil
	}
	for i := 0; i+56 <= len(raw); i += 56 { // MIB_TCP6ROW_OWNER_PID: localAddr[16], scope, localPort, remoteAddr[16], scope, remotePort, state, pid
		rows = append(rows, listenRow{
			addr: net.IP(append([]byte(nil), raw[i:i+16]...)),
			port: int(binary.BigEndian.Uint16(raw[i+20 : i+22])),
			pid:  binary.LittleEndian.Uint32(raw[i+52 : i+56]),
		})
	}
	return rows, nil
}

// tcpTable is the listener table of family af, its rows as raw bytes (after the entry count).
func tcpTable(af uint32) ([]byte, error) { return tcpTableOf(af, tcpTableOwnerPIDListener) }

// tcpTableOf is the table of the given class (listeners, or all connections) of family af.
func tcpTableOf(af, class uint32) ([]byte, error) {
	var size uint32
	procGetExtendedTcpTable.Call(0, uintptr(unsafe.Pointer(&size)), 0, uintptr(af), uintptr(class), 0)
	for attempt := 0; attempt < 4; attempt++ {
		if size == 0 {
			size = 4096
		}
		buf := make([]byte, size)
		r, _, _ := procGetExtendedTcpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, uintptr(af), uintptr(class), 0)
		switch windows.Errno(r) {
		case 0:
			n := binary.LittleEndian.Uint32(buf[0:4])
			rowSize := uint32(24)
			if af == afInet6 {
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

// connRow is one row of the TCP table with its owner and both ends.
type connRow struct {
	lAddr, rAddr net.IP
	lPort, rPort int
	state        uint32
	pid          uint32
}

// connReadWindow and connReadGap bound the re-reading of the table for the connection's row: a handful of reads in about two seconds.
var (
	connReadWindow = 2 * time.Second
	connReadGap    = 200 * time.Millisecond
	tcpConns       = tcpConnections // the table of all connections; a test replaces it
)

// connectionOwner connects to host:port now and reads the table for the row of the server end of that connection (local end host:port, remote end our own client port, established). connected is false when
// nothing accepted the connection. A row that never appears, or two, is an error: the owner is not known.
func connectionOwner(host string, port int) (pid uint32, connected bool, err error) {
	h := strings.Trim(host, "[]")
	if strings.EqualFold(h, "localhost") {
		h = "127.0.0.1"
	}
	conn, derr := net.DialTimeout("tcp", net.JoinHostPort(h, strconv.Itoa(port)), time.Second)
	if derr != nil {
		return 0, false, nil
	}
	defer conn.Close()
	local, ok := conn.LocalAddr().(*net.TCPAddr)
	if !ok {
		return 0, true, errors.New("the connection's own port is not known")
	}
	ip := net.ParseIP(h)
	if ip == nil {
		return 0, true, errors.New("not an IP address: " + host)
	}
	af := uint32(afInet6)
	if ip4 := ip.To4(); ip4 != nil {
		ip, af = ip4, afInet
	}
	deadline := time.Now().Add(connReadWindow)
	for {
		rows, rerr := tcpConns(af)
		if rerr != nil {
			return 0, true, rerr
		}
		var pids []uint32
		for _, r := range rows {
			if r.state == tcpStateEstablished && r.lPort == port && r.rPort == local.Port && r.lAddr.Equal(ip) && r.rAddr.Equal(local.IP) {
				pids = append(pids, r.pid)
			}
		}
		switch {
		case len(pids) == 1:
			return pids[0], true, nil
		case len(pids) > 1:
			return 0, true, errors.New("the table shows two owners for the connection")
		}
		if time.Now().After(deadline) {
			return 0, true, errors.New("the system's table never showed who owns the connection")
		}
		time.Sleep(connReadGap)
	}
}

// tcpConnections is the table of every TCP connection of family af with its owner.
func tcpConnections(af uint32) ([]connRow, error) {
	raw, err := tcpTableOf(af, tcpTableOwnerPIDAll)
	if err != nil {
		return nil, err
	}
	var rows []connRow
	if af == afInet {
		for i := 0; i+24 <= len(raw); i += 24 { // MIB_TCPROW_OWNER_PID: state, localAddr, localPort, remoteAddr, remotePort, pid
			rows = append(rows, connRow{
				state: binary.LittleEndian.Uint32(raw[i : i+4]),
				lAddr: net.IP(append([]byte(nil), raw[i+4:i+8]...)), lPort: int(binary.BigEndian.Uint16(raw[i+8 : i+10])),
				rAddr: net.IP(append([]byte(nil), raw[i+12:i+16]...)), rPort: int(binary.BigEndian.Uint16(raw[i+16 : i+18])),
				pid: binary.LittleEndian.Uint32(raw[i+20 : i+24]),
			})
		}
		return rows, nil
	}
	for i := 0; i+56 <= len(raw); i += 56 { // MIB_TCP6ROW_OWNER_PID: localAddr[16], scope, localPort, remoteAddr[16], scope, remotePort, state, pid
		rows = append(rows, connRow{
			lAddr: net.IP(append([]byte(nil), raw[i:i+16]...)), lPort: int(binary.BigEndian.Uint16(raw[i+20 : i+22])),
			rAddr: net.IP(append([]byte(nil), raw[i+24:i+40]...)), rPort: int(binary.BigEndian.Uint16(raw[i+44 : i+46])),
			state: binary.LittleEndian.Uint32(raw[i+48 : i+52]),
			pid:   binary.LittleEndian.Uint32(raw[i+52 : i+56]),
		})
	}
	return rows, nil
}
