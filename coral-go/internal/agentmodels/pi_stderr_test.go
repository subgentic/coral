package agentmodels

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21604: pi 0.73.1 prints --list-models to stderr. A pi that does so still gives its models; one that prints to stdout still does.
func TestPiModelsAreReadFromStderr(t *testing.T) {
	table := filepath.Join("testdata", "pi-0.73.1-list-models.txt")
	for name, redirect := range map[string]string{"stderr": " >&2", "stdout": ""} {
		t.Run(name, func(t *testing.T) {
			abs, err := filepath.Abs(table)
			require.NoError(t, err)
			cli := filepath.Join(t.TempDir(), "pi")
			require.NoError(t, os.WriteFile(cli, []byte("#!/bin/sh\n[ \"$1\" = --list-models ] && cat '"+abs+"'"+redirect+"\n"), 0o755))
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
