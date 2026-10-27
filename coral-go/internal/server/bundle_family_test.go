package server

import (
	"errors"
	"io/fs"
	"testing"
	"time"

	"github.com/subgentic/coral/pkg/frontend"
)

// The heap is returned to the OS once, after the bundle is built and not before (#8749, #8759): the garbage it leaves is what the call frees. The hook looks at the server at the
// moment it runs.
func TestBundleBuildReturnsItsMemory(t *testing.T) {
	staticSub, err := fs.Sub(frontend.Static, "static")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{staticVersion: "build"}
	realFree, realDelay := freeOSMemory, releaseDelay
	t.Cleanup(func() { freeOSMemory, releaseDelay = realFree, realDelay })
	releaseDelay = 10 * time.Millisecond
	ran := make(chan bool, 4)
	freeOSMemory = func() { ran <- s.bundleBase != "" }
	bundleFS := s.buildBundleFamily(staticSub)
	if bundleFS == nil || s.bundleBase == "" {
		t.Fatalf("the family did not build: fs %v, base %q", bundleFS, s.bundleBase)
	}
	select {
	case builtAtCall := <-ran:
		if !builtAtCall {
			t.Error("FreeOSMemory ran before the bundle was built: its garbage was not there to free")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("FreeOSMemory never ran after the build")
	}
	time.Sleep(100 * time.Millisecond)
	if len(ran) != 0 {
		t.Errorf("FreeOSMemory ran %d more times, want once", len(ran))
	}
}

// With the family off nothing is built and so nothing is freed; with no build id (no static tree to hash) likewise.
func TestNoBundleNoFreeOSMemory(t *testing.T) {
	staticSub, _ := fs.Sub(frontend.Static, "static")
	realFree, realDelay := freeOSMemory, releaseDelay
	t.Cleanup(func() { freeOSMemory, releaseDelay = realFree, realDelay })
	releaseDelay = time.Millisecond
	ran := make(chan struct{}, 4)
	freeOSMemory = func() { ran <- struct{}{} }
	t.Setenv("CORAL_NO_BUNDLE", "1")
	if fsys := (&Server{staticVersion: "build"}).buildBundleFamily(staticSub); fsys != nil {
		t.Errorf("CORAL_NO_BUNDLE=1 built %v", fsys)
	}
	t.Setenv("CORAL_NO_BUNDLE", "")
	if fsys := (&Server{}).buildBundleFamily(staticSub); fsys != nil {
		t.Errorf("no build id built %v", fsys)
	}
	time.Sleep(100 * time.Millisecond)
	if len(ran) != 0 {
		t.Errorf("FreeOSMemory ran %d times with nothing built", len(ran))
	}
}

// A prebuilt family (#8760) is served as it is: no build, so no garbage to free and no call to free it; the family is the one the source returned.
func TestPrebuiltBundleIsNotFollowedByFreeOSMemory(t *testing.T) {
	staticSub, _ := fs.Sub(frontend.Static, "static")
	index, _ := fs.ReadFile(frontend.Templates, "templates/index.html")
	built, err := frontend.BuildBundle(staticSub, index)
	if err != nil {
		t.Fatal(err)
	}
	realFree, realDelay, realSource := freeOSMemory, releaseDelay, bundleSource
	t.Cleanup(func() { freeOSMemory, releaseDelay, bundleSource = realFree, realDelay, realSource })
	releaseDelay = time.Millisecond
	ran := make(chan struct{}, 4)
	freeOSMemory = func() { ran <- struct{}{} }
	bundleSource = func(fs.FS, []byte) (*frontend.Bundle, string, error) { return built, "prebuilt", nil }
	s := &Server{staticVersion: "build"}
	if fsys := s.buildBundleFamily(staticSub); fsys == nil || s.bundleBase == "" {
		t.Fatalf("the prebuilt family was not served: fs %v, base %q", fsys, s.bundleBase)
	}
	time.Sleep(100 * time.Millisecond)
	if len(ran) != 0 {
		t.Errorf("FreeOSMemory ran after a prebuilt family: %d", len(ran))
	}
	// and a build that fails still gets the call (its garbage is the same), and serves the original files
	bundleSource = func(fs.FS, []byte) (*frontend.Bundle, string, error) { return nil, "built", errBundle }
	s2 := &Server{staticVersion: "build"}
	if fsys := s2.buildBundleFamily(staticSub); fsys != nil || s2.bundleBase != "" {
		t.Errorf("a failed build served a family: %v %q", fsys, s2.bundleBase)
	}
	select {
	case <-ran:
	case <-time.After(5 * time.Second):
		t.Error("a failed build was not followed by FreeOSMemory")
	}
}

var errBundle = errors.New("the build failed")
