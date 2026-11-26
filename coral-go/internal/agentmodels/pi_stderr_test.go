package agentmodels

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakePiEnv names the variables a copy of this test binary reads to act as pi: the table to print and the stream to print it on. A shell script cannot be the fake on Windows (#21648), and a copy of the test binary runs
// the same everywhere. The variables are not CORAL_ ones, so they pass to the CLI the way a user's own settings do.
const (
	fakePiTable  = "FAKEPI_TABLE"
	fakePiStream = "FAKEPI_STREAM"
)

func init() {
	if os.Getenv(fakePiTable) == "" || len(os.Args) != 2 || os.Args[1] != "--list-models" {
		return
	}
	b, err := os.ReadFile(os.Getenv(fakePiTable))
	if err != nil {
		os.Exit(1)
	}
	out := os.Stdout
	if os.Getenv(fakePiStream) == "stderr" {
		out = os.Stderr
	}
	_, _ = out.Write(b)
	os.Exit(0)
}

// fakePi is a "pi" that is a copy of this test binary: run as `pi --list-models` it prints table on stream and exits 0.
func fakePi(t *testing.T, table, stream string) string {
	t.Helper()
	self, err := os.Executable()
	require.NoError(t, err)
	src, err := os.ReadFile(self)
	require.NoError(t, err)
	name := "pi"
	if runtime.GOOS == "windows" {
		name = "pi.exe"
	}
	cli := filepath.Join(t.TempDir(), name)
	require.NoError(t, os.WriteFile(cli, src, 0o755))
	t.Setenv(fakePiTable, table)
	t.Setenv(fakePiStream, stream)
	return cli
}

// #21604: pi 0.73.1 prints --list-models to stderr. A pi that does so still gives its models; one that prints to stdout still does.
func TestPiModelsAreReadFromStderr(t *testing.T) {
	table, err := filepath.Abs(filepath.Join("testdata", "pi-0.73.1-list-models.txt"))
	require.NoError(t, err)
	for _, stream := range []string{"stderr", "stdout"} {
		t.Run(stream, func(t *testing.T) {
			cli := fakePi(t, table, stream)
			models, source, err := FetchFromCLI(context.Background(), "pi", cli)
			require.NoError(t, err)
			assert.Equal(t, "account", source)
			assert.NotEmpty(t, models)
			want, perr := ParsePiModels(fixture(t, "pi-0.73.1-list-models.txt"))
			require.NoError(t, perr)
			assert.Equal(t, want, models)
		})
	}
}

// #21618: a warning pi prints after the table is not a model.
func TestParsePiModelsSkipsATrailingWarning(t *testing.T) {
	clean, err := ParsePiModels(fixture(t, "pi-0.73.1-list-models.txt"))
	require.NoError(t, err)
	got, err := ParsePiModels(fixture(t, "pi-0.73.1-list-models-trailing-warning.txt"))
	require.NoError(t, err)
	assert.Equal(t, clean, got)
	for _, m := range got {
		assert.True(t, ValidModelValue(m.Value), m.Value)
	}
}
