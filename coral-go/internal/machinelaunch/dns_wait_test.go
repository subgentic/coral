package machinelaunch

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12885: a machine whose setup died at its first network call said only "Could not resolve host". Now the setup waits (bounded) for DNS before its first download and logs which way it went, root's DNS and egress state is
// kept for the launcher's failure report, and the report prints it.

func needSh(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the machine's scripts run on Linux; stubs here are shell scripts")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
}

// fakeBin makes a folder of stub programs (name -> shell body) to put first on PATH.
func fakeBin(t *testing.T, progs map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range progs {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755))
	}
	return dir
}

func runWith(t *testing.T, bin, script string, args ...string) (string, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "s.sh")
	require.NoError(t, os.WriteFile(path, []byte(script), 0o755))
	cmd := exec.Command("sh", append([]string{path}, args...)...)
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestTheDNSWaitGoesOnTheMomentTheNameResolves(t *testing.T) {
	needSh(t)
	counter := filepath.Join(t.TempDir(), "n")
	// getent fails twice, then answers
	bin := fakeBin(t, map[string]string{"getent": `n=$(cat ` + counter + ` 2>/dev/null || echo 0); n=$((n+1)); echo $n > ` + counter + `; [ "$n" -ge 3 ]`, "sleep": "exit 0"})
	out, err := runWith(t, bin, "#!/bin/sh\nset -eu\n"+dnsWaitSnippet(60)+"\necho after\n")
	require.NoError(t, err, out)
	assert.Contains(t, out, "github.com resolved after 2 s")
	assert.Contains(t, out, "the clock is plausible after 0 s", "the real clock here is not 1970")
	assert.Regexp(t, `20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T`, out, "every line carries a time")
	assert.Contains(t, out, "after", "the setup went on")
	assert.NotContains(t, out, "going on")
}

// The clock is waited for as well: a machine still at 1970 fails TLS on certificate dates even when DNS answers.
func TestTheClockWaitGoesOnWhenTheYearBecomesPlausibleAndGivesUpSayingSo(t *testing.T) {
	needSh(t)
	counter := filepath.Join(t.TempDir(), "n")
	// date: the year is 1970 for two asks, then 2026; the time stamp is a fixed line
	date := `case "$*" in *%Y-%m*) echo 2026-11-07T00:00:00Z ;; *) n=$(cat ` + counter + ` 2>/dev/null || echo 0); n=$((n+1)); echo $n > ` + counter + `; if [ "$n" -ge 3 ]; then echo 2026; else echo 1970; fi ;; esac`
	bin := fakeBin(t, map[string]string{"getent": "exit 0", "sleep": "exit 0", "date": date, "timedatectl": "exit 1"})
	out, err := runWith(t, bin, "#!/bin/sh\nset -eu\n"+dnsWaitSnippet(60)+"\necho after\n")
	require.NoError(t, err, out)
	assert.Contains(t, out, "the clock is plausible after 2 s")
	// a clock that never settles: the setup says so and goes on
	bin = fakeBin(t, map[string]string{"getent": "exit 0", "sleep": "exit 0", "date": `case "$*" in *%Y-%m*) echo 1970-01-01T00:02:00Z ;; *) echo 1970 ;; esac`, "timedatectl": `echo "NTPSynchronized=no"`})
	out, err = runWith(t, bin, "#!/bin/sh\nset -eu\n"+dnsWaitSnippet(3)+"\necho after\n")
	require.NoError(t, err, "the setup is never stopped for the clock: %s", out)
	assert.Contains(t, out, "the clock is not plausible after 3 s: going on")
	assert.Contains(t, out, "after")
	// the machine says it is synchronised: that is enough, whatever the year says
	bin = fakeBin(t, map[string]string{"getent": "exit 0", "sleep": "exit 0", "date": `case "$*" in *%Y-%m*) echo 1970-01-01T00:02:00Z ;; *) echo 1970 ;; esac`, "timedatectl": `echo yes`})
	out, err = runWith(t, bin, "#!/bin/sh\nset -eu\n"+dnsWaitSnippet(3)+"\necho after\n")
	require.NoError(t, err, out)
	assert.NotContains(t, out, "not plausible")
}

func TestTheDNSWaitGivesUpAfterItsBoundAndSaysSoWithTheResolverState(t *testing.T) {
	needSh(t)
	bin := fakeBin(t, map[string]string{"getent": "exit 2", "sleep": "exit 0", "resolvectl": `echo "FAKE-RESOLVECTL-STATUS"`})
	out, err := runWith(t, bin, "#!/bin/sh\nset -eu\n"+dnsWaitSnippet(3)+"\necho after\n")
	require.NoError(t, err, "a name that never resolves does not stop the setup: the download fails with its own error: %s", out)
	assert.Contains(t, out, "github.com did not resolve in 3 s: going on")
	assert.Contains(t, out, "FAKE-RESOLVECTL-STATUS", "the resolver state is in the setup log")
	assert.Contains(t, out, "after")
	assert.NotContains(t, out, "resolved after")
}

func TestTheDNSWaitIsBoundedAndBeforeTheFirstDownload(t *testing.T) {
	s := setupScript("2.0.59", ReleaseDigests{AMD64: strings.Repeat("a", 64), ARM64: strings.Repeat("b", 64)})
	wait := strings.Index(s, "getent hosts github.com")
	curl := strings.Index(s, "curl -fsSL")
	require.Greater(t, wait, 0, "the wait is in the setup")
	require.Greater(t, curl, 0)
	assert.Less(t, wait, curl, "DNS is waited for before the first download")
	assert.Contains(t, s, "-ge 60", "about a minute")
	assert.Equal(t, 60, dnsWaitSeconds)
	needSh(t)
	require.NoError(t, exec.Command("sh", "-n", "-c", s).Run(), "the setup still parses")
}

func TestTheStateModeReportsEveryPieceAndNeverFails(t *testing.T) {
	needSh(t)
	// every command it asks fails: it still says each heading and exits 0
	dir := t.TempDir()
	nft := filepath.Join(dir, "nft")
	require.NoError(t, os.WriteFile(nft, []byte("#!/bin/sh\nexit 1\n"), 0o755))
	bin := fakeBin(t, map[string]string{"resolvectl": "exit 1", "journalctl": "exit 1", "timedatectl": "exit 1", "systemctl": "exit 1", "cloud-init": "exit 1", "date": "exit 1", "uptime": "exit 1"})
	script := strings.ReplaceAll(EgressCheckScript(), "/usr/sbin/nft", nft)
	out, err := runWith(t, bin, script, "state")
	require.NoError(t, err, "state only reports: %s", out)
	for _, heading := range []string{"== date -u / uptime -s", "== timedatectl", "== cloud-init status --long", "== systemctl is-active (network-online, timesyncd, resolved)", "== resolvectl status", "== /etc/resolv.conf", "== upstream resolvers (resolved)", "== journal: coral-egress-resolvers, systemd-resolved", "== nft table"} {
		assert.Contains(t, out, heading)
	}
	// and what the commands say is carried
	bin = fakeBin(t, map[string]string{"resolvectl": `echo "Link 2 (eth0) DNS Servers: 67.207.67.2"`, "journalctl": `echo "coral-egress: the DNS resolver 10.116.0.2 is inside a blocked range"`, "timedatectl": `echo NTPSynchronized=no`, "systemctl": `echo active`, "cloud-init": `echo "last_update: Thu, 01 Jan 1970 00:02:00 +0000"`, "date": `echo 1970-01-01`, "uptime": `echo 1970-01-01 00:00:05`})
	require.NoError(t, os.WriteFile(nft, []byte("#!/bin/sh\necho 'table inet coral_egress'\n"), 0o755))
	out, err = runWith(t, bin, script, "state")
	require.NoError(t, err, out)
	assert.Contains(t, out, "67.207.67.2")
	assert.Contains(t, out, "inside a blocked range")
	assert.Contains(t, out, "table inet coral_egress")
	assert.Contains(t, out, "NTPSynchronized=no")
	assert.Contains(t, out, "last_update: Thu, 01 Jan 1970")
}

func TestTheUserDataKeepsRootsDNSStateWhereTheLaunchKeysUserCanRead(t *testing.T) {
	ud, err := BuildUserData(goldenSpec())
	require.NoError(t, err)
	assert.Contains(t, ud, "/usr/local/sbin/coral-egress-check state > /run/coral/dns.txt")
	assert.Contains(t, ud, "chmod 0644 /run/coral/setup.log /run/coral/setup.status\n", "the log and the status are for the launch key's user")
	assert.NotContains(t, ud, "setup.status /run/coral/dns.txt", "the DNS state is not world-readable")
	assert.Contains(t, ud, "chmod 0600 /run/coral/dns.txt; chown root:coral /run/coral/dns.txt && chmod 0640 /run/coral/dns.txt", "root only first, then root and coral")
	assert.Contains(t, ud, "/usr/local/sbin/coral-egress-check state > /run/coral/dns.start.txt")
	assert.Contains(t, ud, "chmod 0600 /run/coral/dns.start.txt; chown root:coral /run/coral/dns.start.txt && chmod 0640 /run/coral/dns.start.txt")
	start := strings.Index(ud, "state > /run/coral/dns.start.txt")
	setupRun := strings.Index(ud, "/usr/local/sbin/coral-machine-setup > /run/coral/setup.log")
	require.Greater(t, start, 0)
	assert.Less(t, start, setupRun, "the state is kept BEFORE the setup too: a setup that hangs never reaches the one after")
	state := strings.Index(ud, "coral-egress-check state")
	finish := strings.Index(ud, `[ "$rc" = 0 ] || exit "$rc"`)
	require.Greater(t, state, 0)
	assert.Less(t, state, finish, "kept whether the setup succeeded or not")
}

func TestTheFailureReportReadsTheDNSStateAndEndsWithTheSetupsOwnOutput(t *testing.T) {
	assert.Contains(t, whyCommand, "/run/coral/dns.txt")
	assert.Contains(t, whyCommand, "/run/coral/dns.start.txt", "the state before the setup too: a setup that hangs never writes the one after")
	assert.Less(t, strings.Index(whyCommand, "dns.start.txt"), strings.Index(whyCommand, "dns.txt 2>&1"), "before, then after")
	dns := strings.Index(whyCommand, "dns.txt")
	setupOut := strings.Index(whyCommand, "setup output")
	status := strings.Index(whyCommand, "setup exit status")
	assert.Less(t, dns, setupOut)
	assert.Less(t, setupOut, status, "the report is cut to its end: what matters most comes last")
}

// The DNS state is the machine's lookup history: 0640 root:coral, owner first so it is never group-readable by another group. The user-data's own lines are run, with the folder swapped and a stub chown.
func TestTheDNSStateFileIsRootAndCoralOnly(t *testing.T) {
	needSh(t)
	ud, err := BuildUserData(goldenSpec())
	require.NoError(t, err)
	for _, name := range []string{"dns.txt", "dns.start.txt"} {
		testStateFileMode(t, ud, name)
	}
}

func testStateFileMode(t *testing.T, ud, name string) {
	t.Helper()
	var step string
	for _, l := range strings.Split(ud, "\n") {
		if strings.Contains(l, "chown root:coral /run/coral/"+name) {
			step = strings.TrimSpace(l)
		}
	}
	require.NotEmpty(t, step, name)
	dir := t.TempDir()
	file := filepath.Join(dir, name)
	require.NoError(t, os.WriteFile(file, []byte("state"), 0o644)) // as the redirect makes it, world-readable until the step runs
	chownLog := filepath.Join(dir, "chown.log")
	bin := fakeBin(t, map[string]string{"chown": `echo "$@" > ` + chownLog})
	script := "#!/bin/sh\nset -eu\n" + strings.ReplaceAll(step, "/run/coral/"+name, file) + "\n"
	out, err := runWith(t, bin, script)
	require.NoError(t, err, out)
	fi, err := os.Stat(file)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o640), fi.Mode().Perm(), "root and coral only")
	got, _ := os.ReadFile(chownLog)
	assert.Equal(t, "root:coral "+file+"\n", string(got))
	// chmod does not run when the owner could not be set: the file never ends up group-readable for nobody's group
	bin = fakeBin(t, map[string]string{"chown": "exit 1"})
	require.NoError(t, os.WriteFile(file, []byte("state"), 0o644))
	require.NoError(t, os.Chmod(file, 0o644)) // as the redirect makes it
	_, _ = runWith(t, bin, "#!/bin/sh\nset -u\n"+strings.ReplaceAll(step, "/run/coral/"+name, file)+"\n")
	fi, _ = os.Stat(file)
	assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm(), "a failed chown leaves the file root-only, never 0644 and never group-readable for a group it was not given to")
}

// DevOps's finding on f73cf1bae: the report keeps the END of the file, so the short high-value lines (the clock, the service states, the NTP state) must be last and survive a worst-case file. Every command is stubbed to
// say as much as it can; the last bytes the report reads (the size is read from whyCommand itself) still hold the date, the is-active lines and timedatectl.
func TestTheClockAndServiceStatesSurviveTheTailOfAWorstCaseStateFile(t *testing.T) {
	needSh(t)
	long := strings.Repeat("x", 300)
	many := `i=0; while [ $i -lt 60 ]; do echo "` + long + `"; i=$((i+1)); done`
	dir := t.TempDir()
	nft := filepath.Join(dir, "nft")
	require.NoError(t, os.WriteFile(nft, []byte("#!/bin/sh\n"+many+"\n"), 0o755))
	bin := fakeBin(t, map[string]string{
		"resolvectl": many, "journalctl": many, "cloud-init": many,
		"timedatectl": `echo NTPSynchronized=no; echo Timezone=Etc/UTC`,
		"systemctl":   `echo inactive`,
		"date":        `echo "Thu Jan  1 00:02:00 UTC 1970"`,
		"uptime":      `echo "1970-01-01 00:00:05"`,
	})
	script := strings.ReplaceAll(EgressCheckScript(), "/usr/sbin/nft", nft)
	out, err := runWith(t, bin, script, "state")
	require.NoError(t, err, out)
	m := regexp.MustCompile(`tail -c (\d+) /run/coral/dns\.txt`).FindStringSubmatch(whyCommand)
	require.Len(t, m, 2, "the report's read of the file")
	n, err := strconv.Atoi(m[1])
	require.NoError(t, err)
	assert.Greater(t, len(out), n, "this file really is bigger than what the report reads")
	tail := out[len(out)-n:]
	for _, want := range []string{"== date -u / uptime -s", "Thu Jan  1 00:02:00 UTC 1970", "1970-01-01 00:00:05", "== timedatectl", "NTPSynchronized=no", "== systemctl is-active", "inactive", "== cloud-init status --long"} {
		assert.Contains(t, tail, want, "the last %d bytes keep it", n)
	}
	// and each bulky part is capped on its own, so the file is bounded however much the commands say
	assert.Less(t, len(out), 4500, "capped per section")
}
