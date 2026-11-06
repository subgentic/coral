package frontend

import (
	"os"
	"path/filepath"
	"runtime"

	"github.com/evanw/esbuild/pkg/api"
)

// esbuildRoot is the folder every esbuild pass in this package is told it runs in (AbsWorkingDir): a volume's root, with no folder above it.
// Left unset, esbuild takes the process's working folder and resolves it on disk on each pass, a stat of every folder above it; in a test binary
// that folder is the package's, and go test records each stat as an input of the cached result. The plugins resolve every import inside the
// embedded tree (embeddedFiles, the lazy plugin: a path that is not relative, or leaves the tree, is an error), so esbuild never reads a file
// from this folder.
var esbuildRoot = func() string {
	if runtime.GOOS != "windows" {
		return "/"
	}
	if v := filepath.VolumeName(os.Getenv("SystemDrive") + `\`); v != "" {
		return v + `\`
	}
	return `C:\`
}()

// build is api.Build with AbsWorkingDir set to esbuildRoot. Every esbuild build in this package goes through it
// (TestEveryEsbuildBuildRunsFromTheFixedRoot).
func build(opts api.BuildOptions) api.BuildResult {
	opts.AbsWorkingDir = esbuildRoot
	return api.Build(opts)
}
