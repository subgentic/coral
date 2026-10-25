package server

import (
	"io/fs"
	"reflect"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/frontend"
)

// registerStatic builds the embedded frontend's version and bundle once per process, and every server shares that build (a test binary starts hundreds of servers; each
// used to run esbuild and hash every static file again). What is shared is the same bytes a fresh build gives.
func TestEmbeddedStaticBuildIsMadeOnceAndEqualsAFreshBuild(t *testing.T) {
	staticSub, err := fs.Sub(staticFS, "static")
	require.NoError(t, err)
	index, err := fs.ReadFile(frontend.Templates, "templates/index.html")
	require.NoError(t, err)

	first, _, err := embeddedBundleSource(staticSub, index)
	require.NoError(t, err)
	second, _, err := embeddedBundleSource(staticSub, index)
	require.NoError(t, err)
	require.Same(t, first, second, "one build for every caller in the process")

	fresh, err := frontend.BuildBundle(staticSub, index)
	require.NoError(t, err)
	require.Equal(t, fresh.Modules, first.Modules)
	require.True(t, reflect.DeepEqual(fresh.Files, first.Files), "the shared bundle's bytes equal a fresh build's")

	v1, err := embeddedStaticVersion(staticSub)
	require.NoError(t, err)
	v2, err := embeddedStaticVersion(staticSub)
	require.NoError(t, err)
	freshVersion, err := staticBuildVersion(staticSub)
	require.NoError(t, err)
	require.Equal(t, freshVersion, v1, "the shared version equals a fresh hash")
	require.Equal(t, v1, v2)
}

// Two servers of one process serve the same build id.
func TestTwoServersShareOneStaticBuild(t *testing.T) {
	a, _, _ := strictServer(t, false)
	b, _, _ := strictServer(t, false)
	require.NotEmpty(t, a.staticVersion)
	require.Equal(t, a.staticVersion, b.staticVersion)
	require.Equal(t, a.bundleBase, b.bundleBase)
}
