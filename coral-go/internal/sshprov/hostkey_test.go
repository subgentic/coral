package sshprov

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// blobFor is a well formed key blob: the type string, then some key bytes.
func blobFor(typ string, body byte) (string, string) {
	b := make([]byte, 4, 64)
	binary.BigEndian.PutUint32(b, uint32(len(typ)))
	b = append(b, typ...)
	b = append(b, 0, 0, 0, 8, body, body, body, body, body, body, body, body)
	sum := sha256.Sum256(b)
	return base64.StdEncoding.EncodeToString(b), "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

func TestParseKeyLineIsStrict(t *testing.T) {
	blob, fp := blobFor("ssh-ed25519", 7)
	k, ok := parseKeyLine("box.example.com ssh-ed25519 "+blob, "box.example.com")
	if !ok || k.Fingerprint != fp || k.Line() != "box.example.com ssh-ed25519 "+blob {
		t.Fatalf("good line: %+v %v", k, ok)
	}
	rsaBlob, _ := blobFor("ssh-rsa", 1)
	for name, line := range map[string]string{
		"other host":      "other.example.com ssh-ed25519 " + blob,
		"comment field":   "box.example.com ssh-ed25519 " + blob + " root@box",
		"unknown type":    "box.example.com ssh-dss " + blob,
		"type mismatch":   "box.example.com ssh-ed25519 " + rsaBlob,
		"bad base64":      "box.example.com ssh-ed25519 !!!!",
		"padding trick":   "box.example.com ssh-ed25519 " + blob + "=",
		"two hosts":       "box.example.com,evil ssh-ed25519 " + blob,
		"options prefix":  `command="x" box.example.com ssh-ed25519 ` + blob,
		"empty":           "",
		"marker":          "@revoked box.example.com ssh-ed25519 " + blob,
		"short blob":      "box.example.com ssh-ed25519 AAAA",
		"hashed host":     "|1|abc|def ssh-ed25519 " + blob,
		"newline in line": "box.example.com ssh-ed25519 " + blob + "\nevil ssh-ed25519 " + blob,
	} {
		if _, ok := parseKeyLine(line, "box.example.com"); ok {
			t.Errorf("%s: accepted", name)
		}
	}
}

func fakeKeyscan(t *testing.T, out string, code int) string {
	t.Helper()
	return newStandIn(t, "ssh-keyscan", standCfg{Stdout: out + "\n", Exit: code})
}

func TestScanPrefersEd25519AndNamesNonDefaultPorts(t *testing.T) {
	rsa, _ := blobFor("ssh-rsa", 1)
	ed, fp := blobFor("ssh-ed25519", 2)
	out := "# box.example.com:2222 SSH-2.0-OpenSSH\n[box.example.com]:2222 ssh-rsa " + rsa + "\n[box.example.com]:2222 ssh-ed25519 " + ed
	k, err := (Runner{KeyScan: fakeKeyscan(t, out, 0)}).Scan(context.Background(), "box.example.com", 2222)
	if err != nil || k.Type != "ssh-ed25519" || k.Fingerprint != fp || k.Host != "[box.example.com]:2222" {
		t.Fatalf("Scan = %+v, %v", k, err)
	}
}

func TestScanRefusesAnythingThatIsNotAKey(t *testing.T) {
	ed, _ := blobFor("ssh-ed25519", 2)
	for name, out := range map[string]string{
		"empty":         "",
		"garbage line":  "hello world",
		"wrong host":    "evil.example.com ssh-ed25519 " + ed,
		"one good, one": "box.example.com ssh-ed25519 " + ed + "\nnot a key",
	} {
		if k, err := (Runner{KeyScan: fakeKeyscan(t, out, 0)}).Scan(context.Background(), "box.example.com", 22); !errors.Is(err, ErrHostKeyScan) {
			t.Errorf("%s: %+v, %v", name, k, err)
		}
	}
	if _, err := (Runner{}).Scan(context.Background(), "-oProxyCommand=x", 22); !errors.Is(err, ErrBadTarget) {
		t.Errorf("a host that is an option: %v", err)
	}
	if _, err := (Runner{}).Scan(context.Background(), "box.example.com", 0); !errors.Is(err, ErrBadTarget) {
		t.Errorf("port 0: %v", err)
	}
}

func TestTrustWritesTheConfirmedKeyAt0600AndNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "known_hosts")
	ed, _ := blobFor("ssh-ed25519", 2)
	k, ok := parseKeyLine("box.example.com ssh-ed25519 "+ed, "box.example.com")
	if !ok {
		t.Fatal("setup")
	}
	if err := Trust(path, k); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(path)
	dst, _ := os.Stat(filepath.Dir(path))
	if permsApply() && (st.Mode().Perm() != 0o600 || dst.Mode().Perm() != 0o700) {
		t.Errorf("modes: file %v folder %v", st.Mode().Perm(), dst.Mode().Perm())
	}
	if b, _ := os.ReadFile(path); string(b) != k.Line()+"\n" {
		t.Errorf("file = %q", b)
	}
	if err := Trust(path, k); err != nil { // already there: nothing added
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); strings.Count(string(b), "\n") != 1 {
		t.Errorf("the same key was written twice: %q", b)
	}
	other, _ := blobFor("ssh-ed25519", 9)
	changed, _ := parseKeyLine("box.example.com ssh-ed25519 "+other, "box.example.com")
	if err := Trust(path, changed); !errors.Is(err, ErrKeyConflict) {
		t.Errorf("a changed key: %v", err)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), other) {
		t.Error("a different key was written over a known host")
	}
	// a line without a trailing newline and a hashed entry do not break the append
	if err := os.WriteFile(path, []byte("|1|aa|bb ssh-ed25519 "+ed+"\nelse.example.com ssh-ed25519 "+ed), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Trust(path, k); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); !strings.HasSuffix(string(b), "else.example.com ssh-ed25519 "+ed+"\n"+k.Line()+"\n") {
		t.Errorf("file = %q", b)
	}
	if err := Trust(path, HostKey{Host: "x", Type: "ssh-ed25519", Blob: "zzz"}); !errors.Is(err, ErrHostKeyScan) {
		t.Errorf("a key that does not parse was written: %v", err)
	}
}

// realKey makes an ed25519 key with ssh-keygen and returns its public key as type and base64.
func realKey(t *testing.T) (typ, blob string) {
	t.Helper()
	dir := t.TempDir()
	if out, err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", filepath.Join(dir, "k")).CombinedOutput(); err != nil {
		t.Skipf("ssh-keygen is not available: %v %s", err, out)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "k.pub"))
	f := strings.Fields(string(b))
	return f[0], f[1]
}

func TestTrustSeesHashedKnownHostsToo(t *testing.T) {
	needRealKeygen(t)
	typ, blob := realKey(t)
	typ2, blob2 := realKey(t)
	path := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(path, []byte("box.example.com "+typ+" "+blob+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("ssh-keygen", "-H", "-f", path).CombinedOutput(); err != nil {
		t.Skipf("ssh-keygen -H: %v %s", err, out)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), "box.example.com") || !strings.HasPrefix(string(b), "|1|") {
		t.Fatalf("the file is not hashed: %q", b)
	}
	same, ok1 := parseKeyLine("box.example.com "+typ+" "+blob, "box.example.com")
	other, ok2 := parseKeyLine("box.example.com "+typ2+" "+blob2, "box.example.com")
	if !ok1 || !ok2 {
		t.Fatal("setup")
	}
	before, _ := os.ReadFile(path)
	if err := Trust(path, other); !errors.Is(err, ErrKeyConflict) {
		t.Errorf("a different key for a host the hashed file knows: %v", err)
	}
	if err := Trust(path, same); err != nil {
		t.Errorf("the key the hashed file already has: %v", err)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Errorf("the hashed file was changed:\n%s\n--\n%s", before, after)
	}
	unknown, _ := parseKeyLine("else.example.com "+typ2+" "+blob2, "else.example.com")
	if err := Trust(path, unknown); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(path); !strings.HasSuffix(string(after), "else.example.com "+typ2+" "+blob2+"\n") {
		t.Errorf("a new host was not appended: %q", after)
	}
}

func TestScanAcceptsAnIPv6Literal(t *testing.T) {
	ed, _ := blobFor("ssh-ed25519", 2)
	k, err := (Runner{KeyScan: fakeKeyscan(t, "2001:db8::1 ssh-ed25519 "+ed, 0)}).Scan(context.Background(), "2001:db8::1", 22)
	if err != nil || k.Host != "2001:db8::1" {
		t.Errorf("%+v %v", k, err)
	}
	if _, err := (Runner{}).Scan(context.Background(), "2001:db8::1;rm", 22); !errors.Is(err, ErrBadTarget) {
		t.Errorf("a colon in a non-address host: %v", err)
	}
}

func TestScanAliasReadsTheKeyIntoAFreshTempFileAndDeletesIt(t *testing.T) {
	ed, fp := blobFor("ssh-ed25519", 3)
	dir := t.TempDir()
	log := filepath.Join(dir, "argv")
	tmpSeen := filepath.Join(dir, "tmpfile")
	ssh := newStandIn(t, "ssh", standCfg{Log: log, Exit: 255, KnownHosts: "build.internal ssh-ed25519 " + ed + "\n", KnownHostsPath: tmpSeen})
	tg, _ := FromAlias("build-box")
	keys, err := (Runner{SSH: ssh}).ScanAlias(context.Background(), tg)
	if err != nil || len(keys) != 1 || keys[0].Fingerprint != fp || keys[0].Host != "build.internal" || keys[0].Type != "ssh-ed25519" {
		t.Fatalf("ScanAlias = %+v, %v", keys, err)
	}
	b, _ := os.ReadFile(log)
	argv := string(b)
	if strings.Count(argv, "StrictHostKeyChecking=") != 1 || !strings.Contains(argv, "StrictHostKeyChecking=no") {
		t.Errorf("exactly one StrictHostKeyChecking, and it is no (into the temp file):\n%s", argv)
	}
	for _, want := range []string{"GlobalKnownHostsFile=/dev/null", "HashKnownHosts=no", "BatchMode=yes", "PreferredAuthentications=none", "PubkeyAuthentication=no", "IdentityAgent=none", "--\nbuild-box\ntrue\n"} {
		if !strings.Contains(argv, want) {
			t.Errorf("argv lacks %q:\n%s", want, argv)
		}
	}
	tmp, _ := os.ReadFile(tmpSeen)
	if strings.Contains(string(tmp), ".ssh") || !strings.Contains(string(tmp), "coral-hostkey-") {
		t.Errorf("the known_hosts file was not a fresh temp one: %s", tmp)
	}
	if _, err := os.Stat(filepath.Dir(string(tmp))); err == nil {
		t.Error("the temp known_hosts folder was not deleted")
	}
	if _, err := (Runner{SSH: ssh}).ScanAlias(context.Background(), Target{User: "u", Host: "h", Port: 22}); err == nil {
		t.Error("ScanAlias took a target that is not an alias")
	}
}

func TestScanAliasReturnsEveryHostOfAJumpPathAndNothingElse(t *testing.T) {
	jump, jfp := blobFor("ssh-ed25519", 4)
	dest, dfp := blobFor("ssh-ed25519", 5)
	rsa, _ := blobFor("ssh-rsa", 6)
	ssh := newStandIn(t, "ssh", standCfg{Exit: 255, KnownHosts: "jump.example.com ssh-ed25519 " + jump + "\ninner.example.com ssh-rsa " + rsa + "\ninner.example.com ssh-ed25519 " + dest + "\n"})
	tg, _ := FromAlias("inner")
	keys, err := (Runner{SSH: ssh}).ScanAlias(context.Background(), tg)
	if err != nil || len(keys) != 2 || keys[0].Host != "inner.example.com" || keys[0].Fingerprint != dfp || keys[1].Host != "jump.example.com" || keys[1].Fingerprint != jfp {
		t.Fatalf("ScanAlias = %+v, %v", keys, err)
	}
	empty := newStandIn(t, "ssh", standCfg{Exit: 255})
	if _, err := (Runner{SSH: empty}).ScanAlias(context.Background(), tg); !errors.Is(err, ErrHostKeyScan) {
		t.Errorf("no stored key: %v", err)
	}
}

// The jump hops of a ProxyJump alias are run by ssh from the config, not from our argv: the scan gives them the same safety through a temporary config (-F, which ssh hands to each hop). The safety lines
// come FIRST (ssh keeps the first value), forwarding is off for the hops, the owner's config is included after them, and the file is gone afterwards.
func TestScanAliasGivesTheJumpHopsTheScanSafetyThroughATemporaryConfig(t *testing.T) {
	ed, _ := blobFor("ssh-ed25519", 3)
	dir := t.TempDir()
	copyTo := filepath.Join(dir, "config.copy")
	seen := filepath.Join(dir, "config.path")
	ssh := newStandIn(t, "ssh", standCfg{Exit: 255, KnownHosts: "jump.example.com ssh-ed25519 " + ed + "\n", ConfigCopy: copyTo, ConfigPath: seen})
	tg, _ := FromAlias("far-box")
	if _, err := (Runner{SSH: ssh, Config: "/home/user/my ssh/config"}).ScanAlias(context.Background(), tg); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(copyTo)
	cfg := string(b)
	tmpKnown := ""
	for _, l := range strings.Split(cfg, "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "UserKnownHostsFile ") {
			tmpKnown = strings.Trim(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), "UserKnownHostsFile ")), `"`)
		}
	}
	if !strings.Contains(tmpKnown, "coral-hostkey-") || strings.Contains(tmpKnown, ".ssh") {
		t.Errorf("the hops' known_hosts is not the scan's temporary one: %q\n%s", tmpKnown, cfg)
	}
	for _, want := range []string{"Host *\n", "StrictHostKeyChecking no", "GlobalKnownHostsFile ", "HashKnownHosts no", "BatchMode yes", "ForwardAgent no", "ForwardX11 no", "ClearAllForwardings yes", "PermitLocalCommand no",
		"GSSAPIAuthentication no", "GSSAPIDelegateCredentials no", "ControlMaster no", "ControlPath none", "ControlPersist no", `Include "/home/user/my ssh/config"`} {
		if !strings.Contains(cfg, want) {
			t.Errorf("the temporary config lacks %q:\n%s", want, cfg)
		}
	}
	if i, j := strings.Index(cfg, "ForwardAgent no"), strings.Index(cfg, "Include"); i < 0 || j < 0 || i > j {
		t.Errorf("the owner's config must come after the safety lines (ssh keeps the first value):\n%s", cfg)
	}
	if strings.Contains(cfg, "IdentityAgent") || strings.Contains(cfg, "PreferredAuthentications") {
		t.Errorf("the hops must be able to sign in as the owner's config says (a jump opens a channel only for someone who did):\n%s", cfg)
	}
	p, _ := os.ReadFile(seen)
	if _, err := os.Stat(string(p)); err == nil {
		t.Error("the temporary config was left behind")
	}
	// a config path that could break out of the quotes is refused before ssh is started
	if _, err := (Runner{SSH: ssh, Config: "/x\"\nProxyCommand evil"}).ScanAlias(context.Background(), tg); !errors.Is(err, ErrBadTarget) {
		t.Errorf("a config path with a quote and a newline: %v", err)
	}
}
