package hubproxy

import (
	"go/build"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20055: the production limits are 30 s, and a release build has no way to change them.

func TestTheProductionLimitsAreThirtySeconds(t *testing.T) {
	assert.Equal(t, 30*time.Second, headerTimeout, "the header limit a machine has to start its reply")
	assert.Equal(t, 30*time.Second, defaultHeaderTimeout)
	assert.Equal(t, 30*time.Second, defaultUploadStallTimeout)
	assert.Equal(t, 30*time.Second, Options{}.stallTimeout(), "an unset UploadStallTimeout is the 30 s default")
	assert.Equal(t, 30*time.Second, Options{UploadStallTimeout: time.Hour}.stallTimeout(), "and it can only be shortened")
}

// The hook is in a file that a release build does not compile, so it is not in a release binary; this reads the build the way go build does.
func TestAReleaseBuildHasNoHookToChangeTheLimits(t *testing.T) {
	const hook, tag = "SetHeaderTimeoutForTest", "hubproxy_testhooks"
	release, err := build.Default.ImportDir(".", 0)
	require.NoError(t, err)
	ctx := build.Default
	ctx.BuildTags = append(append([]string{}, ctx.BuildTags...), tag)
	tagged, err := ctx.ImportDir(".", 0)
	require.NoError(t, err)
	assert.NotContains(t, release.GoFiles, "timeouts_testhook.go", "a release build must not compile the hook")
	assert.Contains(t, tagged.GoFiles, "timeouts_testhook.go", "and the tag is what adds it")
	for _, f := range release.GoFiles {
		b, err := os.ReadFile(f)
		require.NoError(t, err)
		assert.NotContains(t, string(b), hook, "%s is in a release build and names the hook", f)
	}
	// nothing outside tests calls it, and no build script or workflow sets the tag. A scan that cannot walk, cannot read, or finds no file proves nothing, so each of these fails the test (Security's INFO on #20055).
	scan := func(dir string, want func(p string) bool, visit func(p string, b []byte)) {
		t.Helper()
		seen := 0
		walkErr := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if d.Name() == "node_modules" || d.Name() == ".git" {
					return filepath.SkipDir
				}
				return nil
			}
			if !want(p) {
				return nil
			}
			b, rerr := os.ReadFile(p)
			if rerr != nil {
				return rerr
			}
			seen++
			visit(p, b)
			return nil
		})
		require.NoError(t, walkErr, "the scan of %s could not finish", dir)
		require.Positive(t, seen, "the scan of %s saw no file, so it checked nothing", dir)
	}
	scan(filepath.Join("..", ".."), func(p string) bool {
		ext := filepath.Ext(p)
		return !strings.HasSuffix(p, "_test.go") && filepath.Base(p) != "timeouts_testhook.go" && (ext == ".go" || ext == ".sh" || ext == ".yml" || ext == ".yaml" || filepath.Base(p) == "Makefile")
	}, func(p string, b []byte) {
		assert.NotContains(t, string(b), hook, p)
		if filepath.Base(p) != "timeouts_pin_test.go" {
			assert.NotContains(t, string(b), tag, p)
		}
	})
	// the repo's own build scripts are one level above the Go module
	for _, dir := range []string{"../../../installers", "../../../tools", "../../../.github/workflows"} {
		scan(dir, func(string) bool { return true }, func(p string, b []byte) { assert.NotContains(t, string(b), tag, p) })
	}
}
