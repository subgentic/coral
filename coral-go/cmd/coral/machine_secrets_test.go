//go:build unix

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/machinelaunch"
)

// Token hygiene (#9934, Security): a provider token and a Hub key reach the program only through a 0600 file (or standard input), never through argv; the program starts no subprocess that could carry one in its
// argv; and no secret reaches the output, the error text or the state file, on success or on a failure after the credential was minted.

// No code of the machine command or its package starts a subprocess: a secret cannot reach another program's argv from here, and `ps` shows nothing.
func TestMachineCodeStartsNoSubprocess(t *testing.T) {
	var files []string
	for _, pat := range []string{"machine*.go", "../../internal/machinelaunch/*.go"} {
		m, err := filepath.Glob(pat)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, m...)
	}
	checked := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		for _, bad := range []string{`"os/exec"`, "exec.Command", "syscall.Exec", "os.StartProcess"} {
			if strings.Contains(string(b), bad) {
				t.Errorf("%s uses %s: a secret could reach another program's argv", f, bad)
			}
		}
	}
	if checked < 10 {
		t.Fatalf("only %d source files were checked: the pattern missed them", checked)
	}
}

// There is no flag that takes a secret's VALUE: --token, --hub-key and the like are unknown flags (exit 2), their value is not echoed, and nothing is called.
func TestMachineTakesNoSecretOnTheCommandLine(t *testing.T) {
	tf, kf, p, h := machineFixture(t)
	secrets := []string{"dop_v1_ARGVTOKEN0123", "chk_ARGVKEY0123456789", "chd_ARGVDESTROY0123456"}
	for _, extra := range [][]string{
		{"--token", secrets[0]}, {"--token=" + secrets[0]}, {"--hub-key", secrets[1]}, {"--hub-key=" + secrets[1]}, {"--key", secrets[1]}, {"--api-key", secrets[1]}, {"--destroy-key", secrets[2]}, {"--hub-destroy", secrets[2]},
	} {
		args := append([]string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3", "--allow-ssh-from", "9.9.9.9", "--yes"}, extra...)
		var out, errb bytes.Buffer
		code := runMachine(args, strings.NewReader(""), &out, &errb)
		if code != 2 {
			t.Errorf("%v: exit %d, want 2 (an unknown flag)", extra, code)
		}
		for _, s := range secrets {
			if strings.Contains(out.String()+errb.String(), s) {
				t.Errorf("%v: the value was echoed: %s", extra, errb.String())
			}
		}
	}
	for _, sub := range []string{"list", "delete", "prune", "forget"} {
		var out, errb bytes.Buffer
		args := []string{sub, "--provider", "digitalocean", "--token-file", tf, "--token", secrets[0]}
		if sub == "delete" || sub == "forget" {
			args = append([]string{sub, "m1"}, args[1:]...)
		}
		if code := runMachine(args, strings.NewReader(""), &out, &errb); code != 2 || strings.Contains(out.String()+errb.String(), secrets[0]) {
			t.Errorf("%s --token: exit %d, output %q", sub, code, out.String()+errb.String())
		}
	}
	if len(p.calls) != 0 || len(h.labels) != 0 {
		t.Fatalf("a refused flag made calls: %v %v", p.calls, h.labels)
	}
}

// failingBoot mints the credential, as the SSH bootstrap does after the handshake, and then fails: the path that must revoke and must still say nothing secret.
type failingBoot struct{}

func (failingBoot) Bootstrap(ctx context.Context, req machinelaunch.BootRequest) (machinelaunch.BootResult, error) {
	if _, err := req.Mint(ctx); err != nil {
		return machinelaunch.BootResult{}, err
	}
	return machinelaunch.BootResult{}, errors.New("the machine did not take its credential")
}

// Not the output, not the error text and not the state file ever holds the token, the Hub key or the credential: after a launch that works, and after one that fails once the credential was minted.
func TestNoSecretReachesTheOutputOrTheStateFileOnSuccessOrFailure(t *testing.T) {
	secrets := []string{"dop_v1_COMMANDTOKEN", "chk_COMMANDKEY0123456789", "chb_COMMANDCREDENTIAL0123"}
	for name, failing := range map[string]bool{"success": false, "failure after the mint": true} {
		tf, kf, _, _ := machineFixture(t)
		if failing {
			newMachineBootstrap = func() machinelaunch.Bootstrapper { return failingBoot{} }
		}
		var out, errb bytes.Buffer
		code := runMachine([]string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--name", "coral-s1", "--coral-version", "2.0.3", "--allow-ssh-from", "9.9.9.9", "--yes"}, strings.NewReader(""), &out, &errb)
		if failing == (code == 0) {
			t.Fatalf("%s: exit %d: %s", name, code, errb.String())
		}
		all := out.String() + errb.String()
		if b, err := os.ReadFile(defaultMachineStatePath()); err == nil {
			all += string(b)
		}
		for _, s := range secrets {
			if strings.Contains(all, s) {
				t.Errorf("%s: %q reached the output or the state file", name, s)
			}
		}
	}
}
