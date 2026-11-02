//go:build unix

package machinelaunch

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSecret(t *testing.T, name, body string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadSecretFileAcceptsAPrivateFileAndTrims(t *testing.T) {
	p := writeSecret(t, "token", "dop_v1_abc\n", 0o600)
	got, err := ReadSecretFile(p, nil)
	if err != nil || got != "dop_v1_abc" {
		t.Fatalf("got %q, %v", got, err)
	}
	if got, err := ReadSecretFile(writeSecret(t, "ro", " k \n", 0o400), nil); err != nil || got != "k" {
		t.Fatalf("a 0400 file: %q, %v", got, err)
	}
}

func TestReadSecretFileRefusesAnUnsafeFileWithoutLeakingIt(t *testing.T) {
	secret := "dop_v1_SUPERSECRET"
	loose := writeSecret(t, "loose", secret, 0o644)
	dir := t.TempDir()
	real := writeSecret(t, "real", secret, 0o600)
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	hard := filepath.Join(dir, "hard")
	if err := os.Link(real, hard); err != nil {
		t.Fatal(err)
	}
	big := writeSecret(t, "big", strings.Repeat("x", maxSecretFile+1), 0o600)
	for name, p := range map[string]string{"world-readable": loose, "symlink": link, "two links": hard, "too big": big, "a directory": dir} {
		_, err := ReadSecretFile(p, nil)
		if err == nil || !errors.Is(err, ErrUnsafeSecretFile) {
			t.Errorf("%s: want ErrUnsafeSecretFile, got %v", name, err)
			continue
		}
		if strings.Contains(err.Error(), "SUPERSECRET") {
			t.Errorf("%s: the error holds the secret: %v", name, err)
		}
	}
}

func TestReadSecretFileEmptyMissingAndStdin(t *testing.T) {
	if _, err := ReadSecretFile(writeSecret(t, "empty", " \n", 0o600), nil); !errors.Is(err, ErrEmptySecret) {
		t.Fatalf("empty: %v", err)
	}
	if _, err := ReadSecretFile(filepath.Join(t.TempDir(), "nope"), nil); err == nil || !strings.Contains(err.Error(), "no such file") {
		t.Fatalf("missing: %v", err)
	}
	if got, err := ReadSecretFile("-", strings.NewReader("tok\n")); err != nil || got != "tok" {
		t.Fatalf("stdin: %q, %v", got, err)
	}
	if _, err := ReadSecretFile("-", strings.NewReader(strings.Repeat("y", maxSecretFile+1))); !errors.Is(err, ErrUnsafeSecretFile) {
		t.Fatalf("a long stdin: %v", err)
	}
}
