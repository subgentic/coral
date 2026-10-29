//go:build unix

package main

import (
	"bytes"
	"context"
	"errors"
	"github.com/subgentic/coral/internal/config"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/machinelaunch"
)

type machineStubProvider struct {
	calls []string
	spec  machinelaunch.Spec
	token string
}

func (s *machineStubProvider) Name() string { return "stubcloud" }
func (s *machineStubProvider) Validate(context.Context) error {
	s.calls = append(s.calls, "validate")
	return nil
}
func (s *machineStubProvider) Price(context.Context, string, string) (machinelaunch.Price, error) {
	s.calls = append(s.calls, "price")
	return machinelaunch.Price{HourlyUSD: 0.03, MonthlyUSD: 21}, nil
}
func (s *machineStubProvider) Create(_ context.Context, sp machinelaunch.Spec) (machinelaunch.Instance, error) {
	s.calls = append(s.calls, "create")
	s.spec = sp
	return machinelaunch.Instance{ID: "7", Name: sp.Name}, nil
}
func (s *machineStubProvider) WaitRunning(_ context.Context, id string) (machinelaunch.Instance, error) {
	s.calls = append(s.calls, "wait")
	return machinelaunch.Instance{ID: id, Name: s.spec.Name, Status: machinelaunch.StatusRunning, IPv4: "203.0.113.9"}, nil
}
func (s *machineStubProvider) Delete(_ context.Context, id string) error {
	s.calls = append(s.calls, "delete:"+id)
	return nil
}

type machineStubHub struct {
	labels     []string
	credential string // "" is the default one
}

func (h *machineStubHub) Mint(_ context.Context, label string) (string, error) {
	h.labels = append(h.labels, label)
	if h.credential != "" {
		return h.credential, nil
	}
	return "chb_COMMANDCREDENTIAL0123", nil
}

// machineStubBoot is the machine's side of the bootstrap: it asks for the credential the way the SSH bootstrap does (after the "handshake"), and records it.
type machineStubBoot struct {
	req        machinelaunch.BootRequest
	credential string
	called     bool
}

func (b *machineStubBoot) Bootstrap(ctx context.Context, req machinelaunch.BootRequest) (machinelaunch.BootResult, error) {
	b.called, b.req = true, req
	cred, err := req.Mint(ctx)
	b.credential = cred
	return machinelaunch.BootResult{State: "connected", Label: "label-from-the-machine"}, err
}

// machineBoot is the bootstrap stub of the current test's fixture.
var machineBoot *machineStubBoot

func machineFixture(t *testing.T) (tokenFile, keyFile string, p *machineStubProvider, h *machineStubHub) {
	t.Helper()
	dir := t.TempDir()
	tokenFile, keyFile = filepath.Join(dir, "token"), filepath.Join(dir, "key")
	if err := os.WriteFile(tokenFile, []byte("dop_v1_COMMANDTOKEN\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, []byte("chk_COMMANDKEY0123456789\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	p, h = &machineStubProvider{}, &machineStubHub{}
	oldP, oldH, oldU, oldB, oldD := newMachineProvider, newMachineHub, machineUserData, newMachineBootstrap, detectSSHSource
	machineBoot = &machineStubBoot{}
	newMachineBootstrap = func() machinelaunch.Bootstrapper { return machineBoot }
	detectSSHSource = func(context.Context) (string, error) { return "203.0.113.5", nil }
	newMachineProvider = func(name, token string) (machinelaunch.Provider, error) {
		if name != "digitalocean" {
			return nil, errors.New("unknown provider")
		}
		p.token = token
		return p, nil
	}
	newMachineHub = func(baseURL, key, terms string) machinelaunch.Minter { return h }
	machineUserData = func(keys *machinelaunch.BootKeys, sshFrom, maxMode, version, hubURL string, agents []string) (string, error) {
		return "#cloud-config\n# " + sshFrom + " " + maxMode + " " + version + " " + strings.Join(agents, ",") + "\n", nil
	}
	t.Cleanup(func() {
		newMachineProvider, newMachineHub, machineUserData, newMachineBootstrap, detectSSHSource = oldP, oldH, oldU, oldB, oldD
	})
	return
}

func TestMachineLaunchHappyPathWiresTheFlagsAndKeepsSecretsOut(t *testing.T) {
	tf, kf, p, h := machineFixture(t)
	var out, errb bytes.Buffer
	code := runMachine([]string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--name", "coral-x1", "--region", "ams3", "--size", "s-1vcpu-2gb",
		"--agents", "claude@2.1.0, codex@0.9.1", "--max-mode", "interact", "--coral-version", "2.0.3", "--ssh-key", "ab:cd", "--yes"}, strings.NewReader(""), &out, &errb)
	if code != 0 {
		t.Fatalf("exit %d: %s / %s", code, out.String(), errb.String())
	}
	if p.token != "dop_v1_COMMANDTOKEN" || len(h.labels) != 1 || h.labels[0] != "coral-x1" {
		t.Fatalf("token %q labels %v", p.token, h.labels)
	}
	if p.spec.Region != "ams3" || p.spec.Size != "s-1vcpu-2gb" || len(p.spec.SSHKeys) != 1 || !strings.Contains(p.spec.UserData, "203.0.113.5 interact 2.0.3 claude@2.1.0,codex@0.9.1") {
		t.Fatalf("spec %+v", p.spec)
	}
	for _, s := range []string{"COMMANDTOKEN", "COMMANDKEY", "COMMANDCREDENTIAL"} {
		if strings.Contains(out.String()+errb.String(), s) {
			t.Fatalf("a secret reached the output: %s", out.String()+errb.String())
		}
	}
}

func TestMachineLaunchRefusesBadUsageAndUnsafeFilesBeforeAnyCall(t *testing.T) {
	tf, kf, p, h := machineFixture(t)
	loose := filepath.Join(t.TempDir(), "loose")
	_ = os.WriteFile(loose, []byte("dop_v1_LOOSE"), 0o644)
	_ = os.Chmod(loose, 0o644)
	base := []string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3", "--yes"}
	cases := map[string][]string{
		"no subcommand":     {},
		"no provider":       {"launch", "--token-file", tf, "--hub-key-file", kf},
		"both from stdin":   {"launch", "--provider", "digitalocean", "--token-file", "-", "--hub-key-file", "-"},
		"bad max mode":      append(append([]string{}, base...), "--max-mode", "root"),
		"bad agent":         append(append([]string{}, base...), "--agents", "evil;rm"),
		"unpinned agent":    append(append([]string{}, base...), "--agents", "claude"),
		"unpinned agy":      append(append([]string{}, base...), "--agents", "agy@unpinned"),
		"loose token file":  {"launch", "--provider", "digitalocean", "--token-file", loose, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3", "--yes"},
		"unknown provider":  append(append([]string{}, base[:2]...), append([]string{"nope"}, base[3:]...)...),
		"stray argument":    append(append([]string{}, base...), "extra"),
		"no version at all": {"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--yes"},
	}
	for name, args := range cases {
		var out, errb bytes.Buffer
		if code := runMachine(args, strings.NewReader(""), &out, &errb); code != 2 {
			t.Errorf("%s: exit %d (%s)", name, code, errb.String())
		}
		if strings.Contains(errb.String()+out.String(), "LOOSE") {
			t.Errorf("%s: the error holds the file's contents", name)
		}
	}
	if len(p.calls) != 0 || len(h.labels) != 0 {
		t.Fatalf("a refused command made calls: %v %v", p.calls, h.labels)
	}
}

func TestMachineLaunchWithoutYesAndNoTerminalMakesNothing(t *testing.T) {
	tf, kf, p, h := machineFixture(t)
	var out, errb bytes.Buffer
	code := runMachine([]string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3"}, strings.NewReader(""), &out, &errb)
	if code != 1 || !strings.Contains(errb.String(), "--yes") || len(h.labels) != 0 || strings.Contains(strings.Join(p.calls, ","), "create") {
		t.Fatalf("exit %d: %s, calls %v", code, errb.String(), p.calls)
	}
}

func TestMachineLaunchTokenFromStdinAndTheKeyFromAFile(t *testing.T) {
	_, kf, p, _ := machineFixture(t)
	var out, errb bytes.Buffer
	code := runMachine([]string{"launch", "--provider", "digitalocean", "--token-file", "-", "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3", "--yes"}, strings.NewReader("dop_v1_FROMSTDIN\n"), &out, &errb)
	if code != 0 || p.token != "dop_v1_FROMSTDIN" {
		t.Fatalf("exit %d token %q: %s", code, p.token, errb.String())
	}
}

func TestMachineLaunchWarnsWhenTheHubIsNotThisBuildsDefault(t *testing.T) {
	for _, hub := range []string{"https://hub.example", config.TierDefaultCloudURL} {
		if hub == "" {
			continue // a build with no default Hub has none to match
		}
		tf, kf, _, _ := machineFixture(t)
		var out, errb bytes.Buffer
		code := runMachine([]string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", hub, "--coral-version", "2.0.3", "--yes"}, strings.NewReader(""), &out, &errb)
		warned := strings.Contains(errb.String(), "is not this build's Coral Hub")
		if code != 0 || warned != (hub != config.TierDefaultCloudURL) {
			t.Fatalf("%s: exit %d, warned %v: %s", hub, code, warned, errb.String())
		}
		if strings.Contains(errb.String(), "COMMANDKEY") {
			t.Fatalf("the warning holds the key: %s", errb.String())
		}
	}
}

// TestMachineLaunchBuildsTheRealUserDataWithNoCredential runs the command with the real user-data builder: the user-data holds no Hub credential (it is minted after the pinned handshake and goes over SSH), no provider token,
// no Hub key and no private key, and carries the launch's public login key and the address SSH accepts; a pinned agy installer and the npm CLIs are accepted.
func TestMachineLaunchBuildsTheRealUserDataWithNoCredential(t *testing.T) {
	tf, kf, p, h := machineFixture(t)
	machineUserData = func(keys *machinelaunch.BootKeys, sshFrom, maxMode, version, hubURL string, agents []string) (string, error) {
		spec := machinelaunch.UserDataSpec{AllowSSHFrom: sshFrom, MaxMode: maxMode, CoralVersion: version, HubURL: hubURL, Agents: agents}
		if err := keys.FillUserData(&spec); err != nil {
			return "", err
		}
		return machinelaunch.BuildUserData(spec)
	}
	h.credential = "chb_REALCREDENTIAL0123456789"
	var out, errb bytes.Buffer
	pin := "agy@sha256:" + strings.Repeat("ab", 32)
	code := runMachine([]string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3",
		"--agents", "claude@2.1.0," + pin, "--allow-ssh-from", "198.51.100.7", "--yes"}, strings.NewReader(""), &out, &errb)
	if code != 0 {
		t.Fatalf("exit %d: %s / %s", code, out.String(), errb.String())
	}
	if machineBoot.credential != "chb_REALCREDENTIAL0123456789" {
		t.Fatalf("the credential reaches the bootstrap, not the user-data: %q", machineBoot.credential)
	}
	if n := strings.Count(p.spec.UserData, "PRIVATE KEY-----\n"); n != 2 { // the begin and the end line of the one block: the single-use host key
		t.Fatalf("the user-data has %d private-key lines, want the host key's two", n)
	}
	for _, secret := range []string{"chb_", "REALCREDENTIAL", "COMMANDTOKEN", "COMMANDKEY"} {
		if strings.Contains(p.spec.UserData, secret) {
			t.Fatalf("the user-data holds %s", secret)
		}
	}
	if !strings.Contains(p.spec.UserData, "from, '198.51.100.7', to, any, port, '22'") || !strings.Contains(p.spec.UserData, "ssh-ed25519 ") {
		t.Fatalf("the user-data names the SSH source and carries the login key:\n%s", p.spec.UserData)
	}
	if !strings.Contains(out.String(), "single-use SSH host key") {
		t.Fatalf("the confirmation says what sits in the user-data: %s", out.String())
	}
}

// --allow-ssh-from is checked before anything is read or made: an address that is every address, or not an address, is refused.
func TestMachineLaunchRefusesABadSSHSourceBeforeAnyCall(t *testing.T) {
	tf, kf, p, h := machineFixture(t)
	for _, bad := range []string{"0.0.0.0", "0.0.0.0/0", "example.com", "1.2.3.4; reboot"} {
		var out, errb bytes.Buffer
		code := runMachine([]string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3", "--allow-ssh-from", bad, "--yes"}, strings.NewReader(""), &out, &errb)
		if code != 2 {
			t.Errorf("%q: exit %d", bad, code)
		}
	}
	if len(p.calls) != 0 || len(h.labels) != 0 {
		t.Fatalf("a refused flag made calls: %v %v", p.calls, h.labels)
	}
}

// With no --allow-ssh-from the address is looked up; a lookup that fails says to name one, and nothing is made.
func TestMachineLaunchNeedsAnSSHSourceItCanFind(t *testing.T) {
	tf, kf, p, h := machineFixture(t)
	detectSSHSource = func(context.Context) (string, error) {
		return "", errors.New("could not find this computer's public address: pass --allow-ssh-from ADDRESS")
	}
	var out, errb bytes.Buffer
	code := runMachine([]string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3", "--yes"}, strings.NewReader(""), &out, &errb)
	if code != 2 || !strings.Contains(errb.String(), "--allow-ssh-from") || len(p.calls) != 0 || len(h.labels) != 0 {
		t.Fatalf("exit %d: %s, calls %v", code, errb.String(), p.calls)
	}
}
