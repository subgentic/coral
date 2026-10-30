package verify

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// runBuilder runs tools/promote_manifest.py build, the program promote.yml writes promote.json with, over the given environment, and returns the file it wrote.
func runBuilder(t *testing.T, env map[string]string) []byte {
	t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed: the workflow's manifest builder cannot run here")
	}
	out := filepath.Join(t.TempDir(), "promote.json")
	cmd := exec.Command(py, "-I", filepath.Join("..", "..", "..", "..", "tools", "promote_manifest.py"), "build")
	cmd.Env = append(systemEnv(), "PROMOTE_OUT="+out)
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("promote_manifest.py build: %v: %s", err, b)
	}
	data, err := os.ReadFile(out)
	require.NoError(t, err)
	return data
}

// systemEnv is what a Windows program needs from the environment to find its system folders. Python started without SystemDrive and ProgramData
// (the Microsoft Store's python3 is) writes its cache under the literal folder %SystemDrive%\ProgramData in the current directory, which is this
// package's source folder (found by #350: it was left untracked in the tree and made the package's test result depend on it).
func systemEnv() []string {
	if runtime.GOOS != "windows" {
		return nil
	}
	var env []string
	for _, k := range []string{"SystemRoot", "SystemDrive", "ProgramData", "ALLUSERSPROFILE", "TEMP", "TMP"} {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	return env
}

func builderEnv(tag, prerelease string) map[string]string {
	return map[string]string{
		"PROMOTE_TAG": tag, "PROMOTE_LIFETIME_DAYS": "30", "PROMOTE_REVOKE": "1.4.100, v1.4.101", "PROMOTE_PRERELEASE": prerelease,
		"PROMOTE_SOURCE_SHA": "0123456789abcdef0123456789abcdef01234567", "PROMOTE_SUMS_SHA256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"GITHUB_REPOSITORY": "subgentic/coral",
	}
}

// The file the workflow's own builder writes is read by the client's strict parser and passes the client's rules against the real pins: this is the manifest
// promote.yml signs, not a hand-made one.
func TestThePromoteWorkflowsManifestIsAcceptedByTheClient(t *testing.T) {
	data := runBuilder(t, builderEnv("v1.4.160", "false"))
	m, err := ParseManifest(data)
	require.NoError(t, err)
	assert.Equal(t, "1.4.160", m.Version)
	assert.Equal(t, []string{"1.4.100", "1.4.101"}, m.Revoked)
	assert.Equal(t, "subgentic/coral", m.Repo)
	pins := DefaultPins()
	assert.NoError(t, CheckManifest(m, pins, State{}, "1.4.159", time.Now()), "a normal promotion of a newer release passes the client's rules")
	assert.Less(t, m.expiresTime().Sub(m.promotedTime()), pins.MaxManifestLifetime, "the lifetime the workflow writes is under the one the client allows")
}

// A promotion of a release that is still a pre-release (the rehearsal's) parses, and the client's rules refuse it: the signature is what the rehearsal checks.
func TestAPrereleasePromotionParsesAndTheRulesRefuseIt(t *testing.T) {
	m, err := ParseManifest(runBuilder(t, builderEnv("v1.4.160", "true")))
	require.NoError(t, err)
	assert.True(t, m.Prerelease)
	err = CheckManifest(m, DefaultPins(), State{}, "1.4.159", time.Now())
	var f *Failure
	require.ErrorAs(t, err, &f)
	assert.Equal(t, StageManifestRules, f.Stage)
}
