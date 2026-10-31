package opencode

import (
	"context"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTheVersionIsParsedStrictly(t *testing.T) {
	for in, want := range map[string]Version{"1.19.5": {1, 19, 5}, "2.2.4\n": {2, 2, 4}, " 3.0.0 ": {3, 0, 0}} {
		got, err := ParseVersion(in)
		require.NoError(t, err, in)
		assert.Equal(t, want, got, in)
	}
	for _, bad := range []string{"", "v1.19.5", "1.19", "1.19.5-beta", "1.19.5\nsecond line", "opencode 1.19.5", "1.19.5 (build 4)", "0.9.1", "1.x.5", "-1.2.3", "１.2.3", "1.2.3.4", strings.Repeat("9", 400) + ".1.1"} {
		_, err := ParseVersion(bad)
		assert.Error(t, err, "%q", bad)
	}
}

// 1.x reads OPENCODE_SERVER_PASSWORD and ignores OPENCODE_PASSWORD (a server given only that is OPEN); 2.x reads OPENCODE_PASSWORD; a later major gets both.
func TestThePasswordVariablesAreChosenByTheMajorVersion(t *testing.T) {
	assert.Equal(t, []string{"OPENCODE_SERVER_PASSWORD"}, PasswordVars(1))
	assert.ElementsMatch(t, []string{"OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"}, PasswordVars(2))
	assert.ElementsMatch(t, []string{"OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD"}, PasswordVars(3), "a major not yet seen: both, which is harmless")
	assert.True(t, AttachesWithSubcommand(1))
	assert.False(t, AttachesWithSubcommand(2))
	for major, wantServer := range map[int]bool{1: true, 2: true, 3: true} {
		env := serverEnv([]string{"OPENCODE_SERVER_PASSWORD=persons", "OPENCODE_PASSWORD=persons"}, "/d", major, "pw", "", "")
		assert.Equal(t, wantServer, containsEnv(env, "OPENCODE_SERVER_PASSWORD=pw"), "major %d", major)
		assert.Equal(t, major >= 2, containsEnv(env, "OPENCODE_PASSWORD=pw"), "major %d", major)
		assert.False(t, containsEnv(env, "OPENCODE_SERVER_PASSWORD=persons") || containsEnv(env, "OPENCODE_PASSWORD=persons"), "the person's own password variables never reach the server")
	}
}

func containsEnv(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
}

func TestEachVersionsServerIsGivenTheVariableItReadsAndAVersionThatIsNotOneStartsNothing(t *testing.T) {
	for version, wantBoth := range map[string]bool{"1.19.5": false, "2.2.4": true} {
		cfg, envFile := stubConfig(t)
		cfg.Version = version
		s, err := Start(context.Background(), cfg, "agent-1")
		require.NoError(t, err, version)
		seen := seenEnv(t, envFile)
		assert.Len(t, seen["OPENCODE_SERVER_PASSWORD"], 64, version)
		if wantBoth {
			assert.Equal(t, seen["OPENCODE_SERVER_PASSWORD"], seen["OPENCODE_PASSWORD"], version)
		} else {
			assert.Empty(t, seen["OPENCODE_PASSWORD"], "1.x ignores it: it is not set")
		}
		assert.Equal(t, version[:1], strconv.Itoa(s.Version.Major))
		s.Stop()
	}
	cfg, envFile := stubConfig(t)
	cfg.Version = "one point two"
	_, err := Start(context.Background(), cfg, "agent-2")
	assert.Error(t, err)
	_, statErr := os.Stat(envFile)
	assert.True(t, os.IsNotExist(statErr), "nothing was started for a version that is not one")
}

// A server that ignores the password variable it was given (opencode 1.x with only OPENCODE_PASSWORD, #137997) is OPEN: the wrong-password probe must refuse it, and every process started for it must be gone.
func TestAServerThatIgnoresItsPasswordIsRefusedAndLeavesNoProcess(t *testing.T) {
	t.Setenv("STANDIN_IGNORE_PASSWORD", "1")
	cfg, envFile := stubConfig(t)
	_, err := Start(context.Background(), cfg, "agent-1")
	require.Error(t, err, "a server that answers a wrong password with 200 is never used")
	assert.Contains(t, err.Error(), "no password")
	raw, rerr := os.ReadFile(envFile + ".pids")
	require.NoError(t, rerr, "the stand-in was started (and so the check is a real one)")
	for _, f := range strings.Fields(string(raw)) {
		pid, _ := strconv.Atoi(f)
		require.Positive(t, pid)
		assert.Eventually(t, func() bool { return syscall.Kill(pid, 0) != nil }, 5_000_000_000, 20_000_000, "process %d is still running", pid)
	}
	_, statErr := os.Stat(StoreFile(cfg.DataDir, "agent-1") + ".never")
	_ = statErr
	recs, _ := os.ReadDir(cfg.DataDir + "/servers/agent-1")
	for _, r := range recs {
		assert.NotEqual(t, "server.json", r.Name(), "no pid record is left for a server that was never used")
	}
}
