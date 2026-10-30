package sshprov

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
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
	dir := t.TempDir()
	p := filepath.Join(dir, "ssh-keyscan")
	body := "#!/bin/sh\ncat <<'EOF_KEYS'\n" + out + "\nEOF_KEYS\nexit " + string(rune('0'+code)) + "\n"
	if err := os.WriteFile(p, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return p
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
	if st.Mode().Perm() != 0o600 || dst.Mode().Perm() != 0o700 {
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
