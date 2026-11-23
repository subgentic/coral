package server

import (
	"errors"
	"io/fs"
	"sync/atomic"
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

// #20782: the post-build release is a timer; a goroutine check (testleak, a closing server) must never find its FreeOSMemory still running. A timer that has not fired is cancelled; one that has fired is waited for.
func TestStoppingTheReleaseTimersCancelsOrWaits(t *testing.T) {
	staticSub, err := fs.Sub(frontend.Static, "static")
	if err != nil {
		t.Fatal(err)
	}
	realFree, realDelay := freeOSMemory, releaseDelay
	t.Cleanup(func() { freeOSMemory, releaseDelay = realFree, realDelay })

	// Not yet fired: cancelled, never runs.
	var ran atomic.Int32
	freeOSMemory, releaseDelay = func() { ran.Add(1) }, time.Hour
	s := &Server{staticVersion: "build"}
	if s.buildBundleFamily(staticSub) == nil {
		t.Fatal("the family did not build")
	}
	s.stopReleaseTimers(time.Minute)
	if ran.Load() != 0 {
		t.Errorf("a cancelled release ran %d times", ran.Load())
	}

	// Fired and still running: waited for, not left for the goroutine check to find.
	started, release := make(chan struct{}), make(chan struct{})
	var finished atomic.Bool
	freeOSMemory, releaseDelay = func() {
		close(started)
		<-release
		finished.Store(true)
	}, time.Millisecond
	s2 := &Server{staticVersion: "build"}
	if s2.buildBundleFamily(staticSub) == nil {
		t.Fatal("the family did not build")
	}
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the release never started")
	}
	returned := make(chan struct{})
	go func() {
		s2.stopReleaseTimers(time.Minute)
		close(returned)
	}()
	select {
	case <-returned:
		t.Fatal("stopReleaseTimers returned while FreeOSMemory was still running")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-returned:
	case <-time.After(10 * time.Second):
		t.Fatal("stopReleaseTimers did not return after FreeOSMemory ended")
	}
	if !finished.Load() {
		t.Error("stopReleaseTimers returned before FreeOSMemory ended")
	}
}

// #20799: a Close does not wait out a long FreeOSMemory: the wait is bounded and says so; the count is the server's own, so another server's release is not waited for.
func TestStoppingTheReleaseTimersIsBoundedAndPerServer(t *testing.T) {
	staticSub, err := fs.Sub(frontend.Static, "static")
	if err != nil {
		t.Fatal(err)
	}
	realFree, realDelay := freeOSMemory, releaseDelay
	t.Cleanup(func() { freeOSMemory, releaseDelay = realFree, realDelay })
	started, release := make(chan struct{}), make(chan struct{})
	freeOSMemory, releaseDelay = func() {
		close(started)
		<-release
	}, time.Millisecond
	slow := &Server{staticVersion: "build"}
	if slow.buildBundleFamily(staticSub) == nil {
		t.Fatal("the family did not build")
	}
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the release never started")
	}
	other := &Server{} // built nothing: nothing of its own to wait for
	if t0 := time.Now(); !other.stopReleaseTimers(time.Minute) || time.Since(t0) > 5*time.Second {
		t.Error("a server with no release of its own waited for another's")
	}
	if t0 := time.Now(); slow.stopReleaseTimers(100*time.Millisecond) || time.Since(t0) > 5*time.Second {
		t.Error("the wait on a running release was not bounded")
	}
	close(release)
	if !slow.stopReleaseTimers(10 * time.Second) {
		t.Error("the release ended but the server still counts it")
	}
}
