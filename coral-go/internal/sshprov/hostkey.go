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
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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
	if !validHostName(host) && net.ParseIP(host) == nil {
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

// ErrKeyConflict means known_hosts already names the host with a different key of the same type: that is a changed key, never something to overwrite.
var ErrKeyConflict = errors.New("sshprov: known_hosts already has a different key for this host")

var knownNameRe = regexp.MustCompile(`^(\[[A-Za-z0-9.:-]{1,253}\]:[0-9]{1,5}|[A-Za-z0-9][A-Za-z0-9.:-]{0,252})$`)

// keygenProgram is ssh-keygen, which reads known_hosts the way ssh does (hashed entries included); a variable for tests.
var keygenProgram = "ssh-keygen"

// existingKeys are the keys known_hosts at path has for name, found by ssh-keygen -F so that a HASHED file (the default on Debian and Ubuntu) is searched too. name is validated first.
func existingKeys(ctx context.Context, path, name string) ([][2]string, error) {
	if !knownNameRe.MatchString(name) {
		return nil, ErrHostKeyScan
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := executil.Command(ctx, keygenProgram, "-F", name, "-f", path)
	var out, errOut capped
	cmd.Stdout, cmd.Stderr, cmd.Stdin, cmd.Env = &out, &errOut, nil, minimalEnv()
	if err := cmd.Run(); err != nil && out.b.Len() == 0 {
		var ee interface{ ExitCode() int }
		if errors.As(err, &ee) && ee.ExitCode() == 1 {
			return nil, nil // not found
		}
		return nil, fmt.Errorf("sshprov: could not search known_hosts: %w", err)
	}
	var keys [][2]string
	for _, line := range strings.Split(out.b.String(), "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 && !strings.HasPrefix(line, "#") {
			keys = append(keys, [2]string{f[1], f[2]})
		}
	}
	return keys, nil
}

// Trust writes k, the key the owner confirmed, to the known_hosts file at path (0600, in a 0700 folder), unless it is already there. A different key of the same type already named for the host,
// in a plain or a hashed file, is refused (ErrKeyConflict): the runner's StrictHostKeyChecking=yes then keeps refusing a changed key, and the owner deals with it by hand.
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
	if err == nil {
		keys, kerr := existingKeys(context.Background(), path, k.Host)
		if kerr != nil {
			return kerr
		}
		for _, e := range keys {
			if e[0] != k.Type {
				continue
			}
			if e[1] == k.Blob {
				return nil
			}
			return ErrKeyConflict
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

// ScanAlias is the host-key step for a Host name of the owner's SSH config, where the real host, port, jump hosts and key file are the config's business (not ours to resolve). After the owner has
// confirmed they want to connect, ONE ssh runs into a FRESH temporary known_hosts file (never the owner's) with StrictHostKeyChecking=no, and the key it stored there is parsed strictly, the file
// deleted, and the keys returned to be shown. ssh stores the key before it authenticates, and the scan offers NO credential (no password, no key, no agent), so it never signs in to a host nobody
// has verified yet: the connection is refused after the key exchange and the non-zero exit is expected. Trust then writes each key the owner confirmed, and every later connection is strict.
// Hashing is off so the stored name is readable. A ProxyJump chain stores one key per host: ALL of them are returned (one per host, its best type), and the caller confirms and trusts each.
func (r Runner) ScanAlias(ctx context.Context, t Target) ([]HostKey, error) {
	if t.Alias == "" || !aliasRe.MatchString(t.Alias) {
		return nil, errors.Join(ErrHostKeyScan, ErrBadTarget)
	}
	dir, err := os.MkdirTemp("", "coral-hostkey-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	tmp := filepath.Join(dir, "known_hosts")
	ssh := r.SSH
	if ssh == "" {
		ssh = "ssh"
	}
	argv := withoutStrict(append([]string{}, sshOptions...))
	argv = append(argv, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile="+tmp, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "HashKnownHosts=no", "-o", "CheckHostIP=no",
		"-o", "PreferredAuthentications=none", "-o", "PubkeyAuthentication=no", "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes",
		"--", t.Destination(), "true")
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := executil.Command(ctx, ssh, argv...)
	var out, errOut capped
	cmd.Stdout, cmd.Stderr, cmd.Stdin, cmd.Env = &out, &errOut, nil, minimalEnv()
	_ = cmd.Run() // a refusal to sign in is the expected end; what matters is what was stored
	data, err := os.ReadFile(tmp)
	if err != nil {
		return nil, fmt.Errorf("%w: no key was stored", ErrHostKeyScan)
	}
	best := map[string]int{}
	pick := map[string]HostKey{}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, _, _ := strings.Cut(line, " ")
		if !knownNameRe.MatchString(name) {
			return nil, fmt.Errorf("%w: unexpected stored key", ErrHostKeyScan)
		}
		k, ok := parseKeyLine(line, name)
		if !ok {
			return nil, fmt.Errorf("%w: unexpected stored key", ErrHostKeyScan)
		}
		for rank, kt := range keyTypes {
			if cur, seen := best[name]; kt == k.Type && (!seen || rank < cur) {
				best[name], pick[name] = rank, k
			}
		}
	}
	if len(pick) == 0 {
		return nil, fmt.Errorf("%w: no key of a type Coral accepts", ErrHostKeyScan)
	}
	if len(pick) > maxAliasHosts {
		return nil, fmt.Errorf("%w: too many hosts in the path", ErrHostKeyScan)
	}
	names := make([]string, 0, len(pick))
	for n := range pick {
		names = append(names, n)
	}
	sort.Strings(names)
	keys := make([]HostKey, 0, len(names))
	for _, n := range names {
		keys = append(keys, pick[n])
	}
	return keys, nil
}

// maxAliasHosts bounds the hosts of one alias's path (the target and its jump hosts).
const maxAliasHosts = 4

// withoutStrict removes the "-o StrictHostKeyChecking=yes" pair of sshOptions, for the one ssh that reads a key into a temporary file.
func withoutStrict(argv []string) []string {
	out := make([]string, 0, len(argv))
	for i := 0; i < len(argv); i++ {
		if argv[i] == "-o" && i+1 < len(argv) && argv[i+1] == "StrictHostKeyChecking=yes" {
			i++
			continue
		}
		out = append(out, argv[i])
	}
	return out
}
