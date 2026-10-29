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

// The network a launch makes (#10918): a stub that makes nothing and says nothing, so these tests keep their own call lists.
func (s *machineStubProvider) CreateVPC(_ context.Context, name, region string) (machinelaunch.VPC, error) {
	return machinelaunch.VPC{ID: "vpc-stub", Name: name, Region: region}, nil
}
func (s *machineStubProvider) DeleteVPC(context.Context, string) error { return nil }
func (s *machineStubProvider) CreateFirewall(_ context.Context, sp machinelaunch.FirewallSpec) (machinelaunch.Firewall, error) {
	return machinelaunch.Firewall{ID: "fw-stub", Name: sp.Name, Tag: sp.Tag}, nil
}
func (s *machineStubProvider) CloseFirewall(context.Context, machinelaunch.Firewall) error {
	return nil
}
func (s *machineStubProvider) DeleteFirewall(context.Context, string) error { return nil }

type machineStubHub struct {
	destroyKey string // the chd_ the command gave the Hub client
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
	t.Setenv("CORAL_DATA_DIR", filepath.Join(dir, "coral-data")) // the state file of a launch goes in Coral's data folder: never the real one (#10918)
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
	newMachineHub = func(baseURL, key, destroyKey string) machinelaunch.Minter { h.destroyKey = destroyKey; return h }
	machineUserData = func(keys *machinelaunch.BootKeys, sshFrom, maxMode, version string, digests machinelaunch.ReleaseDigests, hubURL string, agents []string) (string, error) {
		return "#cloud-config\n# " + sshFrom + " " + maxMode + " " + version + " " + strings.Join(agents, ",") + " " + digests.AMD64 + "\n", nil
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
	machineUserData = func(keys *machinelaunch.BootKeys, sshFrom, maxMode, version string, digests machinelaunch.ReleaseDigests, hubURL string, agents []string) (string, error) {
		spec := machinelaunch.UserDataSpec{AllowSSHFrom: sshFrom, MaxMode: maxMode, CoralVersion: version, CoralDigests: digests, HubURL: hubURL, Agents: agents}
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

// The machine's cap defaults to view: interact and launch are explicit opt-ins (coral-hub Lead's read on the launch design, #10919).
func TestMachineLaunchMaxModeDefaultsToView(t *testing.T) {
	tf, kf, p, _ := machineFixture(t)
	base := []string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3", "--yes"}
	for want, extra := range map[string][]string{"view": nil, "interact": {"--max-mode", "interact"}, "launch": {"--max-mode", "launch"}} {
		var out, errb bytes.Buffer
		if code := runMachine(append(append([]string{}, base...), extra...), strings.NewReader(""), &out, &errb); code != 0 {
			t.Fatalf("%s: exit %d: %s", want, code, errb.String())
		}
		if !strings.Contains(p.spec.UserData, " "+want+" 2.0.3") {
			t.Errorf("max mode %s: the user-data says %q", want, p.spec.UserData)
		}
	}
	var help bytes.Buffer
	machineUsage(&help)
	if !strings.Contains(help.String(), "default view") {
		t.Errorf("the usage says the default: %s", help.String())
	}
}

// The Coral download is checked against a digest the CLI pins, or one the person gives for a version it does not pin; a version with neither is refused before anything is read or made (#10919).
func TestMachineLaunchPinsTheCoralDigest(t *testing.T) {
	tf, kf, p, h := machineFixture(t)
	base := func(version string, extra ...string) []string {
		return append([]string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", version, "--yes"}, extra...)
	}
	pinned, _ := machinelaunch.PinnedReleaseDigests("2.0.3")
	var out, errb bytes.Buffer
	if code := runMachine(base("2.0.3"), strings.NewReader(""), &out, &errb); code != 0 || !strings.Contains(p.spec.UserData, pinned.AMD64) {
		t.Fatalf("a pinned version uses its pinned digest: exit %d %s / %s", code, errb.String(), p.spec.UserData)
	}
	calls := len(p.calls)
	for name, args := range map[string][]string{
		"a version with no pinned digest and none given": base("9.9.9"),
		"one digest only":          base("9.9.9", "--coral-sha256-amd64", strings.Repeat("ab", 32)),
		"a digest that is not hex": base("9.9.9", "--coral-sha256-amd64", "zz", "--coral-sha256-arm64", "zz"),
	} {
		out.Reset()
		errb.Reset()
		if code := runMachine(args, strings.NewReader(""), &out, &errb); code != 2 {
			t.Errorf("%s: exit %d (%s)", name, code, errb.String())
		}
	}
	if len(p.calls) != calls || len(h.labels) != 1 {
		t.Fatalf("a refused version made calls: %v %v", p.calls, h.labels)
	}
	out.Reset()
	errb.Reset()
	given := base("9.9.9", "--coral-sha256-amd64", strings.Repeat("ab", 32), "--coral-sha256-arm64", strings.Repeat("cd", 32))
	if code := runMachine(given, strings.NewReader(""), &out, &errb); code != 0 || !strings.Contains(p.spec.UserData, strings.Repeat("ab", 32)) {
		t.Fatalf("a version with the person's digests is launched with them: exit %d %s", code, errb.String())
	}
}

// --hub-destroy-file is optional: given, the chd_ reaches the Hub client (never the user-data or the output); an unsafe file is refused before any call; none at all launches as before.
func TestMachineLaunchHubDestroyFile(t *testing.T) {
	tf, kf, p, h := machineFixture(t)
	dir := t.TempDir()
	good, loose := filepath.Join(dir, "destroy"), filepath.Join(dir, "loose")
	if err := os.WriteFile(good, []byte("chd_DESTROYCREDENTIAL0123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(loose, []byte("chd_LOOSEDESTROY0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(loose, 0o644)
	base := []string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3", "--yes"}
	var out, errb bytes.Buffer
	if code := runMachine(append(append([]string{}, base...), "--hub-destroy-file", good), strings.NewReader(""), &out, &errb); code != 0 || h.destroyKey != "chd_DESTROYCREDENTIAL0123" {
		t.Fatalf("exit %d, key %q: %s", code, h.destroyKey, errb.String())
	}
	if strings.Contains(out.String()+errb.String()+p.spec.UserData, "DESTROYCREDENTIAL") {
		t.Fatal("the destroy credential reached the output or the user-data")
	}
	calls := len(p.calls)
	out.Reset()
	errb.Reset()
	if code := runMachine(append(append([]string{}, base...), "--hub-destroy-file", loose), strings.NewReader(""), &out, &errb); code != 2 || len(p.calls) != calls || strings.Contains(errb.String(), "LOOSEDESTROY") {
		t.Fatalf("an unsafe file is refused before any call: exit %d, %s", code, errb.String())
	}
	if code := runMachine(append(append([]string{}, base...), "--hub-destroy-file", "-", "--token-file", "-"), strings.NewReader("x"), &out, &errb); code != 2 {
		t.Fatalf("two files from standard input: exit %d", code)
	}
	h.destroyKey = "unset"
	if code := runMachine(base, strings.NewReader(""), &out, &errb); code != 0 || h.destroyKey != "" {
		t.Fatalf("without the file the launch goes on with none: exit %d, key %q", code, h.destroyKey)
	}
}

// The confirmation says the SSH address was looked up at api.ipify.org when the person did not give one, and says nothing of a lookup when they did.
func TestMachineLaunchSaysWhereTheSSHAddressCameFrom(t *testing.T) {
	tf, kf, _, _ := machineFixture(t)
	base := []string{"launch", "--provider", "digitalocean", "--token-file", tf, "--hub-key-file", kf, "--hub-url", "https://hub.example", "--coral-version", "2.0.3", "--yes"}
	var out, errb bytes.Buffer
	if code := runMachine(base, strings.NewReader(""), &out, &errb); code != 0 || !strings.Contains(out.String(), "looked up at api.ipify.org") {
		t.Fatalf("exit %d: %s / %s", code, out.String(), errb.String())
	}
	out.Reset()
	errb.Reset()
	if code := runMachine(append(append([]string{}, base...), "--allow-ssh-from", "198.51.100.7"), strings.NewReader(""), &out, &errb); code != 0 || strings.Contains(out.String(), "looked up") {
		t.Fatalf("exit %d: %s / %s", code, out.String(), errb.String())
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
