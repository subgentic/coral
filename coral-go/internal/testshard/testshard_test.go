package testshard

import (
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setRun(t *testing.T, v string) {
	t.Helper()
	old := flag.Lookup("test.run").Value.String()
	require.NoError(t, flag.Set("test.run", v))
	t.Cleanup(func() { _ = flag.Set("test.run", old) })
}

func list(t *testing.T, body string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "shard.txt")
	require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
	t.Setenv(ListEnv, p)
}

func TestApplyDoesNothingWithoutAList(t *testing.T) {
	t.Setenv(ListEnv, "")
	setRun(t, "")
	require.NoError(t, Apply())
	assert.Equal(t, "", flag.Lookup("test.run").Value.String())
}

func TestApplySelectsExactlyTheListedNames(t *testing.T) {
	setRun(t, "")
	list(t, "TestA\r\nTestB_c\n\nTestD\n")
	require.NoError(t, Apply())
	assert.Equal(t, "^(TestA|TestB_c|TestD)$", flag.Lookup("test.run").Value.String())
}

func TestApplyRefusesARunFilterAndAnEmptyList(t *testing.T) {
	setRun(t, "TestX")
	list(t, "TestA\n")
	assert.Error(t, Apply(), "-run and a shard list select tests twice")
	setRun(t, "")
	list(t, " \n")
	assert.Error(t, Apply(), "an empty list would run nothing and pass")
	t.Setenv(ListEnv, filepath.Join(t.TempDir(), "missing.txt"))
	assert.Error(t, Apply())
}
