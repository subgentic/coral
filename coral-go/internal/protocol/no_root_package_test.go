package protocol

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The module root holds no Go package: the CI shard script strips the module path from
// `go list ./...` and a package at the root is left as `./github.com/...`, which `go test`
// cannot find, so every "rest" shard failed (trial-250). The protocol is embedded from here.
func TestTheModuleRootHoldsNoGoPackage(t *testing.T) {
	root := filepath.Join("..", "..")
	_, err := os.Stat(filepath.Join(root, "go.mod"))
	require.NoError(t, err, "the module root")
	entries, err := os.ReadDir(root)
	require.NoError(t, err)
	for _, e := range entries {
		require.Falsef(t, !e.IsDir() && strings.HasSuffix(e.Name(), ".go"), "%s is a Go file at the module root; put it in a package under internal/", e.Name())
	}
}

func TestTheEmbeddedProtocolIsTheFile(t *testing.T) {
	data, err := os.ReadFile("PROTOCOL.md")
	require.NoError(t, err)
	require.Equal(t, string(data), Text)
	require.NotEmpty(t, Text)
}
