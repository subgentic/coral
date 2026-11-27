package clihelp

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An agent that passed an object, or a file that was not there, was told only Go's decoding error (eval #577): the error says a JSON array is expected and shows one.
func TestAnArtifactsFileErrorSaysWhatItMustHold(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
		return p
	}
	_, err := ReadArtifactManifest(write("object.json", `{"name":"report","uri":"coral://artifacts/abc"}`))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "must hold a JSON array of artifacts")
	assert.Contains(t, err.Error(), ArtifactManifestExample)
	_, err = ReadArtifactManifest(filepath.Join(dir, "missing.json"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "--artifacts takes a JSON file holding an array of artifacts")
	assert.Contains(t, err.Error(), ArtifactManifestExample)
	rows, err := ReadArtifactManifest(write("ok.json", ArtifactManifestExample))
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "report", rows[0]["name"], "the example itself is a valid file")
}
