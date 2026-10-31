package server

import (
	"io/fs"
	"log"
	"runtime/debug"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/pkg/frontend"
)

// freeOSMemory is debug.FreeOSMemory and releaseDelay how long after the build it runs: variables so a test can see when and whether (TestBundleBuildReturnsItsMemory).
var (
	freeOSMemory = debug.FreeOSMemory
	releaseDelay = 2 * time.Second
	bundleSource = frontend.PrebuiltOrBuild // the embedded prebuilt family when it is of this tree, else a build (#8760)
)

// bundleCache is the family built in this process, with the input hash it was built for (frontend.BundleInputHash: the static tree and the
// shell). A server built after the first, for the same tree, reuses it instead of building it again: a running Coral starts one server, so it
// builds once as before, while a test binary starts hundreds, and each one ran about 300 esbuild passes over the same files (in internal/server's
// tests, 657 builds and about 76,000 walks of the package folder that go test records as inputs). Only a family that built is kept: a failed
// build is tried again by the next server. The lock is held through a build, so servers started together wait for one build, not one each.
var bundleCache struct {
	mu  sync.Mutex
	key string
	b   *frontend.Bundle
	how string
}

// reusedHow is what the start-up log says for a family the process had already built.
const reusedHow = "reused (built earlier in this process)"

// cachedBundle is bundleSource through bundleCache. A tree whose input hash can't be read is built as before and not kept.
func cachedBundle(static fs.FS, index []byte) (*frontend.Bundle, string, error) {
	key, err := frontend.BundleInputHash(static, index)
	if err != nil {
		return bundleSource(static, index)
	}
	bundleCache.mu.Lock()
	defer bundleCache.mu.Unlock()
	if bundleCache.b != nil && bundleCache.key == key {
		return bundleCache.b, reusedHow, nil
	}
	b, how, err := bundleSource(static, index)
	if err == nil && b != nil {
		bundleCache.key, bundleCache.b, bundleCache.how = key, b, how
	}
	return b, how, err
}

// resetBundleCache forgets the kept family (tests that swap bundleSource, or count builds).
func resetBundleCache() {
	bundleCache.mu.Lock()
	bundleCache.key, bundleCache.b, bundleCache.how = "", nil, ""
	bundleCache.mu.Unlock()
}

// buildBundleFamily builds the bundled family (#4228: app.js's module graph, the lazy modules and the shell's stylesheets as a few files, next to the unchanged files) from the
// static tree, sets the build id and the bundled prefix on s when it built, and returns the family's file system (nil when the family is off or did not build: the original
// files are served).
//
// The build is the largest thing a server does at start: about 300 esbuild passes allocate 430 MB and grow the Go heap to 230 to 330 MB. Nothing allocates after it, so no collection
// follows soon and the background scavenger gives the memory back far too slowly: an idle server kept 250 to 350 MB, of which 18 to 23 MB was live (#8749). The heap is returned to
// the OS once, releaseDelay after the build, not at its end: the build's own working memory is still referenced for a few hundred milliseconds after BuildBundle returns (a call
// right after it left 110 MB in use, one 400 ms later left 21 MB; measured on Linux, #8759). An idle server is then 85 to 100 MB.
func (s *Server) buildBundleFamily(staticSub fs.FS) fs.FS {
	if s.staticVersion == "" || frontend.BundleDisabled() {
		return nil
	}
	var bundleFS fs.FS
	index, _ := fs.ReadFile(frontend.Templates, "templates/index.html")
	b, how, err := cachedBundle(staticSub, index)
	if err != nil {
		log.Printf("bundled dashboard unavailable, serving the original files: %v", err)
	} else {
		log.Printf("[STARTUP] dashboard bundle: %s", how)
		bundleFS = b.FS(staticSub)
		// The build id names the bytes served, not only the sources: the bundler, its options and
		// the stylesheet order change them with the tree untouched (#4320). It is ONE id for both
		// families, the pop-out's /static/b/ and the bundled /static/bb/, and the X-Coral-Build
		// header the update banner compares with, so they stay the same name for one build.
		s.staticVersion = bundleVersion(s.staticVersion, b)
		s.bundleBase = "/static/bb/" + s.staticVersion + "/"
	}
	// Whether or not the build succeeded: the garbage is the same. A prebuilt family left none (a release reads it back: no esbuild, no 300 MB peak, #8760), nor
	// did one this process had already built.
	if how != "prebuilt" && how != reusedHow {
		// the delay and the call are read now, not when the goroutine runs: a test that swaps them for its own must not have an earlier server's goroutine call its hook late (#8785)
		// A timer, not a goroutine asleep: a test binary builds a server per test, and a sleeping goroutine each is what testleak reports at the end (#4167).
		delay, free := releaseDelay, freeOSMemory
		time.AfterFunc(delay, func() {
			defer safego.Recover("release-build-memory")
			free()
		})
	}
	return bundleFS
}
