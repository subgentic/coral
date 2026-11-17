package machinelaunch

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13575: the egress self-test. Opt-in; the default user-data does not change by a byte (TestUserDataMatchesItsGolden); the test makes outbound requests only and cleans up on every path.

func selftestSpec() UserDataSpec { s := goldenSpec(); s.EgressSelfTest = true; return s }

// withoutTheKeyBlock replaces the host private key's PEM block (a fixed test key) with a placeholder: a golden holding a private-key block trips the secret scan (gitleaks) on every ref.
var keyBlock = regexp.MustCompile(`(?s)-----` + `BEGIN OPENSSH PRIV` + `ATE KEY-----.*?-----` + `END OPENSSH PRIV` + `ATE KEY-----`) // written in pieces: the marker spelled out whole in a source file is itself what a secret scan looks for

func withoutTheKeyBlock(s string) string {
	return keyBlock.ReplaceAllString(s, "<the host private key: a fixed test key, left out of this file>")
}

func TestTheDefaultUserDataNeverMentionsTheSelfTest(t *testing.T) {
	got, err := BuildUserData(goldenSpec())
	require.NoError(t, err)
	for _, w := range []string{"selftest", "self-test", "coral-selftest", selftestUnitName} {
		assert.NotContains(t, got, w, "the default launch carries nothing of the self-test")
	}
	assert.NotContains(t, finishScript(true), "selftest")
	assert.NotContains(t, finishScript(false), "selftest")
}

func TestTheSelfTestUserDataMatchesItsGolden(t *testing.T) {
	raw, err := BuildUserData(selftestSpec())
	require.NoError(t, err)
	got := withoutTheKeyBlock(raw)
	assert.NotContains(t, got, "PRIV"+"ATE KEY")
	path := filepath.Join("testdata", "userdata_selftest.golden.yaml")
	if os.Getenv("UPDATE_USERDATA_GOLDEN") == "1" {
		require.NoError(t, os.WriteFile(path, []byte(got), 0o644))
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "run once with UPDATE_USERDATA_GOLDEN=1, then read the file")
	assert.Equal(t, string(want), got)
	def, _ := BuildUserData(goldenSpec())
	assert.Contains(t, got, selftestScriptPath)
	assert.Contains(t, got, selftestUnitPath)
	assert.NotEqual(t, def, got)
}

// The self-test starts only AFTER every line that closes SSH and removes the keys, and without waiting for it.
func TestTheSelfTestIsTheFinishStepsLastAct(t *testing.T) {
	for _, agents := range []bool{false, true} {
		s := finishScriptWith(agents, true)
		start := strings.Index(s, "systemctl start --no-block "+selftestUnitName)
		require.Greater(t, start, 0)
		for _, closing := range []string{"systemctl mask ssh.socket", "ufw --force delete allow 22/tcp", "rm -f /home/coral/.ssh/authorized_keys", "systemctl disable --now coral-finish.timer"} {
			at := strings.Index(s, closing)
			require.GreaterOrEqual(t, at, 0, closing)
			assert.Less(t, at, start, "%q comes before the self-test (agents=%v)", closing, agents)
		}
	}
}

func TestTheSelfTestScriptIsPOSIXShAndTakesNothingFromOutside(t *testing.T) {
	sc := EgressSelfTestScript()
	path := filepath.Join(t.TempDir(), "st.sh")
	require.NoError(t, os.WriteFile(path, []byte(sc), 0o700))
	out, err := exec.Command("sh", "-n", path).CombinedOutput()
	require.NoError(t, err, string(out))
	// the targets are fixed in the script: no argument, no environment variable, no user-data or Hub file
	// (the functions pass and as_user take their own arguments; the script itself takes none)
	for _, bad := range []string{"${SELF", "$0", "getent", "/run/coral/bootstrap.d", "user-data", "$HUB", "$CORAL", "authorized_keys", "ssh"} {
		assert.NotContains(t, sc, bad)
	}
	assert.Contains(t, sc, "meta=http://169.254.169.254/metadata/v1/id")
	assert.Contains(t, sc, "public=http://1.1.1.1/")
	// the clean-up is a trap, and the report is written after the user is removed
	trap := strings.Index(sc, "trap cleanup EXIT")
	userdel := strings.Index(sc, `userdel -f "$user"`)
	report := strings.Index(sc, `cat "$tmp" >> "$out"`)
	require.True(t, trap > 0 && userdel > 0 && report > 0)
	assert.Less(t, userdel, report, "the throwaway user goes before the report is written")
	assert.Contains(t, sc, "trap 'exit 1' INT TERM", "a kill still runs the clean-up")
	for _, noRetry := range []string{"ufw", "nft add", "nft delete", "nft flush", "iptables", "systemctl stop", "systemctl disable"} {
		assert.NotContains(t, sc, noRetry, "a FAIL opens nothing and changes nothing")
	}
}

// selftestRig runs the real script under sh with stub commands: curl answers per who asks (the stub setpriv marks the throwaway user), the folders are a temp dir.
type selftestRig struct {
	dir, bin, boot string
	metaForUser    bool // the stub lets the throwaway user reach the metadata service (the bug the test must catch)
}

func newSelftestRig(t *testing.T) *selftestRig {
	t.Helper()
	r := &selftestRig{dir: t.TempDir()}
	r.bin = filepath.Join(r.dir, "bin")
	require.NoError(t, os.MkdirAll(r.bin, 0o755))
	r.boot = filepath.Join(r.dir, "boot_id")
	r.setBoot(t, "boot-1")
	stub := func(name, body string) {
		require.NoError(t, os.WriteFile(filepath.Join(r.bin, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755))
	}
	stub("systemctl", "exit 0")
	stub("nft", `echo 'meta skuid != 0 drop'; echo 'meta skuid != 0 drop'`)
	stub("useradd", `echo useradd >> "$LOG"`)
	stub("userdel", `echo userdel >> "$LOG"`)
	stub("id", `echo 4242`)
	stub("setpriv", `while [ $# -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done; AS_USER=1 exec "$@"`)
	stub("ip", `echo '2: eth0    inet 10.116.0.2/20 brd 10.116.15.255 scope global eth1'`)
	stub("curl", `case "$*" in
*169.254.169.254*) if [ -n "${AS_USER:-}" ]; then [ -e "$META_FOR_USER" ] && exit 0; exit 7; else echo 123456; exit 0; fi ;;
*1.1.1.1*) exit 0 ;;
*10.116.0.2*) if [ -n "${AS_USER:-}" ]; then exit 7; fi; exit 0 ;;
esac
exit 7`)
	return r
}

func (r *selftestRig) setBoot(t *testing.T, id string) {
	require.NoError(t, os.WriteFile(r.boot, []byte(id+"\n"), 0o644))
}

func (r *selftestRig) run(t *testing.T) (result, log string) {
	t.Helper()
	sc := EgressSelfTestScript()
	sc = strings.ReplaceAll(sc, "/var/lib/coral-selftest", filepath.Join(r.dir, "state"))
	sc = strings.ReplaceAll(sc, "/proc/sys/kernel/random/boot_id", r.boot)
	path := filepath.Join(r.dir, "st.sh")
	require.NoError(t, os.WriteFile(path, []byte(sc), 0o700))
	cmd := exec.Command("sh", path)
	meta := filepath.Join(r.dir, "meta-for-user")
	if r.metaForUser {
		require.NoError(t, os.WriteFile(meta, nil, 0o644))
	}
	cmd.Env = []string{"PATH=" + r.bin + ":/usr/bin:/bin", "LOG=" + filepath.Join(r.dir, "log"), "META_FOR_USER=" + meta, "TMPDIR=" + r.dir}
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	b, _ := os.ReadFile(filepath.Join(r.dir, "state", "egress-selftest"))
	l, _ := os.ReadFile(filepath.Join(r.dir, "log"))
	return string(b), string(l)
}

func TestTheSelfTestWritesOnlyPassFailLinesAndRunsEachPhaseOnce(t *testing.T) {
	r := newSelftestRig(t)
	got, log := r.run(t)
	line := regexp.MustCompile(`^(PASS|FAIL) [a-z0-9_-]{1,40}$`)
	lines := strings.Split(strings.TrimSpace(got), "\n")
	for _, l := range lines {
		assert.Regexp(t, line, l)
		assert.True(t, strings.HasPrefix(l, "PASS "), "everything passes in the stubbed good world: %s", l)
	}
	assert.Len(t, lines, 6)
	assert.Contains(t, log, "userdel", "the throwaway user is removed")
	assert.NotContains(t, got, "10.116", "no address in the report")
	assert.NotContains(t, got, "123456", "nothing the metadata service said")

	again, _ := r.run(t) // same boot: the reboot phase must wait for a reboot, and the first phase is done
	assert.Equal(t, got, again, "a second start in the same boot adds nothing")

	r.setBoot(t, "boot-2")
	after, _ := r.run(t)
	assert.Contains(t, after, "PASS reboot_rules_present")
	assert.Contains(t, after, "PASS reboot_metadata_blocked_nonroot")
	third, _ := r.run(t)
	assert.Equal(t, after, third, "each phase runs once")
}

func TestTheSelfTestReportsAFailAndStillRemovesTheUser(t *testing.T) {
	r := newSelftestRig(t)
	r.metaForUser = true
	got, log := r.run(t)
	assert.Contains(t, got, "FAIL metadata_blocked_nonroot", "a non-root user that reaches the metadata service is the failure the check exists for")
	assert.Contains(t, log, "userdel")
}
