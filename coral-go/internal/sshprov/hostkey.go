package sshprov

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/executil"
)

// The host-key step (#11370): a host the hub has never connected to has no key in known_hosts, and the runner never accepts one. The step scans the key, shows its fingerprint to the owner as
// text, and only after they confirm writes THAT SAME scanned key (not a second scan, not accept-new) to known_hosts at 0600. The connection that follows is StrictHostKeyChecking=yes as always.

// HostKey is a key scanned from a host: what the owner confirms and what is written.
type HostKey struct {
	Host        string // the host as known_hosts names it: "host", or "[host]:port" for a port other than 22
	Type        string // ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa
	Blob        string // the key, base64 as scanned
	Fingerprint string // "SHA256:" and the unpadded base64 of the key's SHA-256, as ssh prints it
}

// Line is the known_hosts line of the key.
func (k HostKey) Line() string { return k.Host + " " + k.Type + " " + k.Blob }

var keyTypes = []string{"ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"}

// ErrHostKeyScan is every failure of the scan: no answer, no key of a known type, or an answer that is not what ssh-keyscan prints.
var ErrHostKeyScan = errors.New("sshprov: could not read the host's key")

// KnownHostName is how known_hosts names host:port.
func KnownHostName(host string, port int) string {
	if port == 22 {
		return host
	}
	return "[" + host + "]:" + strconv.Itoa(port)
}

// parseKeyLine reads one line of ssh-keyscan output for want (the known_hosts name it was asked for) STRICTLY: exactly "<host> <type> <base64>", the host the one asked for, a type in the list,
// the base64 a key blob whose own leading type string is the type named. Comments and anything else are not keys.
func parseKeyLine(line, want string) (HostKey, bool) {
	f := strings.Fields(line)
	if len(f) != 3 || f[0] != want {
		return HostKey{}, false
	}
	ok := false
	for _, t := range keyTypes {
		ok = ok || f[1] == t
	}
	blob, err := base64.StdEncoding.Strict().DecodeString(f[2])
	if !ok || err != nil || len(blob) < 8 || len(blob) > 16<<10 {
		return HostKey{}, false
	}
	n := binary.BigEndian.Uint32(blob[:4])
	if int(n) != len(f[1]) || len(blob) < 4+int(n) || string(blob[4:4+n]) != f[1] {
		return HostKey{}, false
	}
	sum := sha256.Sum256(blob)
	return HostKey{Host: want, Type: f[1], Blob: f[2], Fingerprint: "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])}, true
}

// Scan asks the host for its key with ssh-keyscan (KeyScan, default "ssh-keyscan"), preferring ed25519. For an alias target the caller resolves the real host and port first (ResolveAlias).
func (r Runner) Scan(ctx context.Context, host string, port int) (HostKey, error) {
	if !validHostName(host) && !strings.Contains(host, ":") {
		return HostKey{}, errors.Join(ErrHostKeyScan, ErrBadTarget)
	}
	if port < 1 || port > 65535 {
		return HostKey{}, errors.Join(ErrHostKeyScan, ErrBadTarget)
	}
	prog := r.KeyScan
	if prog == "" {
		prog = "ssh-keyscan"
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := executil.Command(ctx, prog, "-T", "10", "-p", strconv.Itoa(port), "-t", "ed25519,ecdsa,rsa", "--", host)
	var out, errOut capped
	cmd.Stdout, cmd.Stderr, cmd.Stdin, cmd.Env = &out, &errOut, nil, minimalEnv()
	if err := cmd.Run(); err != nil && out.b.Len() == 0 {
		return HostKey{}, fmt.Errorf("%w: no answer from the host", ErrHostKeyScan)
	}
	want := KnownHostName(host, port)
	// ssh-keyscan names a non-default port "[host]:port"; for port 22 the host. Every line must be a key of a type in the list; the first of the best type wins.
	best := -1
	var pick HostKey
	sc := bufio.NewScanner(bytes.NewReader(out.b.Bytes()))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "#") || strings.TrimSpace(line) == "" {
			continue
		}
		k, ok := parseKeyLine(line, want)
		if !ok {
			return HostKey{}, fmt.Errorf("%w: unexpected answer", ErrHostKeyScan)
		}
		for rank, t := range keyTypes {
			if t == k.Type && (best < 0 || rank < best) {
				best, pick = rank, k
			}
		}
	}
	if best < 0 {
		return HostKey{}, fmt.Errorf("%w: no key of a type Coral accepts", ErrHostKeyScan)
	}
	return pick, nil
}

// DefaultKnownHostsPath is the hub user's ~/.ssh/known_hosts, the file the system ssh reads.
func DefaultKnownHostsPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".ssh", "known_hosts")
}

// ErrKeyConflict means known_hosts already names the host with a different key: that is a changed key, never something to overwrite.
var ErrKeyConflict = errors.New("sshprov: known_hosts already has a different key for this host")

// Trust writes k, the key the owner confirmed, to the known_hosts file at path (0600, in a 0700 folder), unless it is already there. A different key already named for the same host is refused
// (ErrKeyConflict): the runner's StrictHostKeyChecking=yes then keeps refusing a changed key, and the owner deals with it by hand. Hashed entries cannot be compared here; ssh itself still checks them.
func Trust(path string, k HostKey) error {
	if path == "" {
		return errors.New("sshprov: no known_hosts path")
	}
	if _, ok := parseKeyLine(k.Line(), k.Host); !ok {
		return ErrHostKeyScan
	}
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || strings.HasPrefix(f[0], "|1|") || strings.HasPrefix(f[0], "#") {
			continue
		}
		for _, h := range strings.Split(f[0], ",") {
			if h != k.Host {
				continue
			}
			if f[1] == k.Type && f[2] == k.Blob {
				return nil
			}
			if f[1] == k.Type {
				return ErrKeyConflict
			}
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	prefix := ""
	if len(data) > 0 && data[len(data)-1] != '\n' {
		prefix = "\n"
	}
	_, err = f.WriteString(prefix + k.Line() + "\n")
	return err
}
