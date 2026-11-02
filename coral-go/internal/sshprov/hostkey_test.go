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
	"strconv"
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

// The jump hops of a ProxyJump alias are run by ssh from the config, not from our argv: the scan gives them the safety lines (no forwarding, batch mode, no connection sharing) through a temporary
// config (-F, which ssh hands to each hop), BEFORE the owner's own. It gives them NO host-key lines (#12031): a hop is checked as the owner's config says, against the owner's known_hosts, so the scan
// never accepts a hop's key. The owner's config is included after the safety lines and the file is gone afterwards.
func TestScanAliasGivesTheJumpHopsTheScanSafetyAndNoHostKeyRelaxation(t *testing.T) {
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
	for _, want := range []string{"Host *\n", "BatchMode yes", "UpdateHostKeys no", "ForwardAgent no", "ForwardX11 no", "ClearAllForwardings yes", "PermitLocalCommand no",
		"GSSAPIAuthentication no", "GSSAPIDelegateCredentials no", "ControlMaster no", "ControlPath none", "ControlPersist no", `Include "/home/user/my ssh/config"`} {
		if !strings.Contains(cfg, want) {
			t.Errorf("the temporary config lacks %q:\n%s", want, cfg)
		}
	}
	for _, banned := range []string{"StrictHostKeyChecking", "UserKnownHostsFile", "GlobalKnownHostsFile", "HashKnownHosts", "CheckHostIP", "IdentityAgent", "PreferredAuthentications"} {
		if strings.Contains(cfg, banned) {
			t.Errorf("the temporary config must not touch %q for the hops (a hop is checked as the owner's config says, and signs in as it says):\n%s", banned, cfg)
		}
	}
	if i, j := strings.Index(cfg, "ForwardAgent no"), strings.Index(cfg, "Include"); i < 0 || j < 0 || i > j {
		t.Errorf("the owner's config must come after the safety lines (ssh keeps the first value):\n%s", cfg)
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

// #12031 (Security's point 2): a scan that stops on a host key it was not allowed to accept is a HopKeyError, not "no key stored".
func TestScanAliasStopsOnAJumpHostKeyItMayNotAccept(t *testing.T) {
	ssh := newStandIn(t, "ssh", standCfg{Stderr: "Host key verification failed.\n", Exit: 255})
	tg, _ := FromAlias("inner")
	_, err := Runner{SSH: ssh}.ScanAlias(context.Background(), tg)
	var he *HopKeyError
	if !errors.As(err, &he) || !errors.Is(err, ErrHostKeyScan) {
		t.Fatalf("err = %v", err)
	}
}

// #12031: with a two-hop block, the hops the owner has not pinned are the ones named; a hop whose key is in the file its own block names is not. ssh -G and ssh-keygen -F are the real ones.
func TestHopKeyErrorNamesTheHopsTheOwnerHasNotPinned(t *testing.T) {
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no ssh on this computer")
	}
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("no ssh-keygen on this computer")
	}
	dir := t.TempDir()
	key := filepath.Join(dir, "k")
	if out, err := exec.Command(keygen, "-q", "-t", "ed25519", "-N", "", "-f", key).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v %s", err, out)
	}
	pub, _ := os.ReadFile(key + ".pub")
	f := strings.Fields(string(pub))
	known := filepath.Join(dir, "known_hosts")
	if err := os.WriteFile(known, []byte("[jump1.example.com]:2200 "+f[0]+" "+f[1]+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(dir, "config")
	body := "Host inner\n  HostName inner.example.com\n  ProxyJump ops@jump1.example.com:2200,jump2\n" +
		"Host jump1.example.com\n  UserKnownHostsFile " + known + "\n" +
		"Host jump2\n  HostName 10.0.0.2\n  UserKnownHostsFile " + known + "\n"
	if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	tg, _ := FromAlias("inner")
	he, ok := (Runner{}).hopKeyError(context.Background(), sshBin, cfg, tg).(*HopKeyError)
	if !ok {
		t.Fatal("not a HopKeyError")
	}
	if strings.Join(he.Hops, ",") != "ops@jump1.example.com:2200,jump2" || strings.Join(he.Unknown, ",") != "jump2" {
		t.Errorf("hops %v, unknown %v", he.Hops, he.Unknown)
	}
}

// #12031 (Security's SHOULD on #12027): the confirmed key is written under the name ssh itself looks it up by: HostKeyAlias when the block has one, else the HostName (not the alias), in the
// [host]:port form for a port other than 22. For each such block the name is read from ssh -G, Trust writes the key under it, and ssh-keygen -F (which reads known_hosts as ssh does) finds it.
func TestTrustedKeyIsFoundUnderTheNameSshUsesForTheHostBlock(t *testing.T) {
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no ssh on this computer")
	}
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("no ssh-keygen on this computer")
	}
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "k")
	if out, err := exec.Command(keygen, "-q", "-t", "ed25519", "-N", "", "-f", keyFile).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v %s", err, out)
	}
	pub, _ := os.ReadFile(keyFile + ".pub")
	f := strings.Fields(string(pub))
	cfg := filepath.Join(dir, "config")
	blocks := "Host plain\n  HostName real.example.com\n" +
		"Host ported\n  HostName real.example.com\n  Port 2200\n" +
		"Host aliased\n  HostName real.example.com\n  Port 2200\n  HostKeyAlias vault\n" +
		"Host coder.ws\n  ProxyCommand /bin/true\n  UserKnownHostsFile /dev/null\n  StrictHostKeyChecking no\n"
	if err := os.WriteFile(cfg, []byte(blocks), 0o600); err != nil {
		t.Fatal(err)
	}
	for alias, want := range map[string]string{"plain": "real.example.com", "ported": "[real.example.com]:2200", "aliased": "vault", "coder.ws": "coder.ws"} {
		tg, _ := FromAlias(alias)
		got := effectiveSSH(t, sshBin, cfg, Runner{KnownHosts: filepath.Join(dir, "none")}.baseArgv(tg), tg.Destination())
		name := got["hostname"]
		if p := got["port"]; p != "" && p != "22" {
			name = KnownHostName(got["hostname"], atoiOr(p, 22))
		}
		if got["hostkeyalias"] != "" {
			name = got["hostkeyalias"]
		}
		if name != want {
			t.Fatalf("%s: ssh's name for the host is %q, expected %q (ssh -G: %v)", alias, name, want, got)
		}
		known := filepath.Join(dir, "known_"+alias)
		if err := Trust(known, HostKey{Host: name, Type: f[0], Blob: f[1]}); err != nil {
			t.Fatalf("%s: Trust: %v", alias, err)
		}
		if out, err := exec.Command(keygen, "-F", name, "-f", known).CombinedOutput(); err != nil || !strings.Contains(string(out), f[1]) {
			t.Errorf("%s: ssh-keygen -F %q does not find the key Trust wrote: %v %s", alias, name, err, out)
		}
	}
}

func atoiOr(s string, def int) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

// #12031 (Security's SHOULD): read back with ssh -G, the scan's config leaves a hop's UpdateHostKeys off even where the owner's block turns it on: the scan changes no known_hosts of the owner.
func TestScanConfigNeverLetsAHopUpdateTheOwnersKnownHosts(t *testing.T) {
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no ssh on this computer")
	}
	dir := t.TempDir()
	owner := filepath.Join(dir, "owner")
	if err := os.WriteFile(owner, []byte("Host hop\n  HostName hop.example.com\n  UpdateHostKeys yes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfgText, err := scanConfig(owner)
	if err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(dir, "scan")
	if err := os.WriteFile(cfg, []byte(cfgText), 0o600); err != nil {
		t.Fatal(err)
	}
	got := effectiveSSH(t, sshBin, cfg, nil, "hop")
	if got["updatehostkeys"] != "false" {
		t.Errorf("updatehostkeys = %q, want false (the owner's block won)", got["updatehostkeys"])
	}
}

func genKey(t *testing.T, dir string) []string {
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("no ssh-keygen on this computer")
	}
	key := filepath.Join(dir, "k"+strconv.Itoa(len(dir)))
	if out, err := exec.Command(keygen, "-q", "-t", "ed25519", "-N", "", "-f", key).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v %s", err, out)
	}
	pub, _ := os.ReadFile(key + ".pub")
	return strings.Fields(string(pub))
}

// #12056: forgetting a host key removes the lines of THAT host from the file given, hashed or not, and nothing else; a missing file has nothing to forget; a name that is not a host name is refused.
func TestForgetHostKeyRemovesOnlyThatHostFromTheGivenFile(t *testing.T) {
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("no ssh-keygen on this computer")
	}
	dir := t.TempDir()
	a, b := genKey(t, t.TempDir()), genKey(t, t.TempDir())
	known := filepath.Join(dir, "known")
	if err := os.WriteFile(known, []byte("box.example.com "+a[0]+" "+a[1]+"\n[other.example.com]:2200 "+b[0]+" "+b[1]+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ForgetHostKey(context.Background(), known, "box.example.com"); err != nil {
		t.Fatal(err)
	}
	left, _ := os.ReadFile(known)
	if strings.Contains(string(left), "box.example.com") || !strings.Contains(string(left), "[other.example.com]:2200") {
		t.Errorf("only box.example.com goes: %q", left)
	}
	// a hashed file (the default on Debian and Ubuntu)
	if out, err := exec.Command(keygen, "-H", "-f", known).CombinedOutput(); err != nil {
		t.Fatalf("hash: %v %s", err, out)
	}
	if err := ForgetHostKey(context.Background(), known, "[other.example.com]:2200"); err != nil {
		t.Fatal(err)
	}
	if out, _ := exec.Command(keygen, "-F", "[other.example.com]:2200", "-f", known).CombinedOutput(); strings.Contains(string(out), b[1]) {
		t.Errorf("the hashed entry is gone: %s", out)
	}
	if err := ForgetHostKey(context.Background(), filepath.Join(dir, "missing"), "box.example.com"); err != nil {
		t.Errorf("a file that is not there has nothing to forget: %v", err)
	}
	for _, bad := range []string{"", "a b", "../x", "-f", "host\nname"} {
		if err := ForgetHostKey(context.Background(), known, bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
	if err := ForgetHostKey(context.Background(), "", "box.example.com"); err == nil {
		t.Error("no path: refused")
	}
}

// #12056: the name the hub holds a host's key under: a typed target is its host (and [host]:port), an alias is what ssh -G says (HostKeyAlias, else HostName with its port), never the alias itself.
func TestHostKeyNameIsTheNameSshUses(t *testing.T) {
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		t.Skip("no ssh on this computer")
	}
	dir := t.TempDir()
	cfg := filepath.Join(dir, "config")
	if err := os.WriteFile(cfg, []byte("Host plain\n  HostName real.example.com\nHost ported\n  HostName real.example.com\n  Port 2200\nHost aliased\n  HostName real.example.com\n  Port 2200\n  HostKeyAlias vault\nHost coder.ws\n  ProxyCommand /bin/true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := Runner{SSH: sshBin, Config: cfg}
	typed22, _ := ParseTarget("user@box.example.com")
	typed2222, _ := ParseTarget("user@box.example.com:2222")
	for name, c := range map[string]struct {
		target Target
		want   string
	}{"typed": {typed22, "box.example.com"}, "typed with a port": {typed2222, "[box.example.com]:2222"}} {
		if got := r.HostKeyName(context.Background(), c.target); got != c.want {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
	for alias, want := range map[string]string{"plain": "real.example.com", "ported": "[real.example.com]:2200", "aliased": "vault", "coder.ws": "coder.ws"} {
		tg, _ := FromAlias(alias)
		if got := r.HostKeyName(context.Background(), tg); got != want {
			t.Errorf("alias %s: %q, want %q", alias, got, want)
		}
	}
	if got := (Runner{SSH: sshBin, Config: filepath.Join(dir, "missing")}).HostKeyName(context.Background(), Target{Alias: "plain"}); got != "plain" && got != "" {
		t.Logf("a config that is not there answers %q (ssh's own default)", got)
	}
}

// #12056 (Security's SHOULD): what is about to be forgotten is read first, with the fingerprint ssh itself prints, so the owner can set it beside the key the computer presents next.
func TestSavedHostKeysCarryTheFingerprintSshPrints(t *testing.T) {
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("no ssh-keygen on this computer")
	}
	dir := t.TempDir()
	key := filepath.Join(dir, "k")
	if out, err := exec.Command(keygen, "-q", "-t", "ed25519", "-N", "", "-f", key).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v %s", err, out)
	}
	pub, _ := os.ReadFile(key + ".pub")
	f := strings.Fields(string(pub))
	known := filepath.Join(dir, "known")
	if err := os.WriteFile(known, []byte("box.example.com "+f[0]+" "+f[1]+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	want, err := exec.Command(keygen, "-lf", key+".pub").Output()
	if err != nil {
		t.Fatal(err)
	}
	got, err := SavedHostKeys(context.Background(), known, "box.example.com")
	if err != nil || len(got) != 1 {
		t.Fatalf("SavedHostKeys = %+v, %v", got, err)
	}
	if !strings.Contains(string(want), got[0].Fingerprint) || got[0].Type != "ssh-ed25519" || got[0].Host != "box.example.com" {
		t.Errorf("fingerprint %q is not ssh's %q", got[0].Fingerprint, want)
	}
	if none, err := SavedHostKeys(context.Background(), known, "other.example.com"); err != nil || len(none) != 0 {
		t.Errorf("a host the file does not hold has none: %+v %v", none, err)
	}
	if none, err := SavedHostKeys(context.Background(), filepath.Join(dir, "missing"), "box.example.com"); err != nil || len(none) != 0 {
		t.Errorf("a file that is not there has none: %+v %v", none, err)
	}
}
