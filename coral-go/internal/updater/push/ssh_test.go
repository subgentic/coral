package push

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A stand-in ssh (a script) records its argv and echoes stdin: SSH.Run passes the fixed options, "--", the destination and one command, stdin through, and caps what it reads back.
func TestSSHRunUsesTheFixedArgvAndPassesStdin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell stand-in")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "argv")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + log + "\ncat\n"
	bin := filepath.Join(dir, "ssh")
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	out, err := SSH{Dest: "me@box", Bin: bin}.Run(context.Background(), "/opt/coral/coral-update status --json", strings.NewReader("payload"))
	if err != nil || string(out) != "payload" {
		t.Fatalf("%q %v", out, err)
	}
	got, _ := os.ReadFile(log)
	if string(got) != "-a\n-x\n-T\n--\nme@box\n/opt/coral/coral-update status --json\n" {
		t.Fatalf("argv:\n%s", got)
	}
	if _, err := (SSH{Dest: "-oProxyCommand=x", Bin: bin}).Run(context.Background(), "x", nil); err == nil {
		t.Fatal("an option as the destination ran")
	}
}

func TestSSHRunCapsOutputAndHidesTheError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell stand-in")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "ssh")
	os.WriteFile(bin, []byte("#!/bin/sh\nhead -c 200000 /dev/zero\necho secret-host-detail >&2\nexit 255\n"), 0o700)
	out, err := SSH{Dest: "box", Bin: bin}.Run(context.Background(), "x", nil)
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("%v", err)
	}
	if len(out) > MaxOutput {
		t.Fatalf("read %d bytes", len(out))
	}
}

// Output over the cap is dropped, not an error: a remote that prints too much does not fail an otherwise good command.
func TestSSHRunOverCapIsNotAnError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell stand-in")
	}
	bin := filepath.Join(t.TempDir(), "ssh")
	os.WriteFile(bin, []byte("#!/bin/sh\nhead -c 200000 /dev/zero\n"), 0o700)
	out, err := SSH{Dest: "box", Bin: bin}.Run(context.Background(), "x", nil)
	if err != nil || len(out) != MaxOutput {
		t.Fatalf("%d %v", len(out), err)
	}
}
