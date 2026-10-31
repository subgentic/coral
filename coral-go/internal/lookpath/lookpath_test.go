package lookpath

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func tool(t *testing.T, dir, name string) string {
	t.Helper()
	file := name
	if runtime.GOOS == "windows" {
		file += ".exe"
	}
	p := filepath.Join(dir, file)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func fakeClock(t *testing.T) *time.Time {
	t.Helper()
	clock := time.Now()
	f := func() time.Time { return clock }
	Clock.Store(&f)
	t.Cleanup(func() { Clock.Store(nil) })
	return &clock
}

// A "not found" is reused for NotFoundFor only, so a program installed a moment later is picked up.
func TestANotFoundIsRememberedBrieflyAndAFoundIsKept(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	clock := fakeClock(t)
	name := "zzlookpath-tool"

	if _, err := Path(name); err == nil {
		t.Fatal("not installed yet: want an error")
	}
	file := tool(t, dir, name)
	if _, err := Path(name); err == nil {
		t.Error("inside the window the not-found answer is reused (that is the saving)")
	}
	*clock = clock.Add(NotFoundFor + time.Second)
	got, err := Path(name)
	if err != nil || got != file {
		t.Fatalf("after the window the new program is found: %q %v", got, err)
	}
	*clock = clock.Add(time.Hour)
	if again, err := Path(name); err != nil || again != got {
		t.Errorf("a found program is kept: %q %v", again, err)
	}
}

// A found program whose file is gone is looked up again, not handed out.
func TestAFoundProgramThatIsGoneIsLookedUpAgain(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	fakeClock(t)
	name := "zzlookpath-gone"
	file := tool(t, dir, name)
	if got, err := Path(name); err != nil || got != file {
		t.Fatalf("found: %q %v", got, err)
	}
	os.Remove(file)
	if got, err := Path(name); err == nil {
		t.Errorf("the file is gone but %q was handed out", got)
	}
}

// Another PATH is another question; a name with a folder in it is not remembered.
func TestAnotherPathAsksAgainAndAFolderNameIsNotAPathLookup(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	fakeClock(t)
	name := "zzlookpath-two"
	fileA := tool(t, a, name)
	t.Setenv("PATH", a)
	if got, err := Path(name); err != nil || got != fileA {
		t.Fatalf("A: %q %v", got, err)
	}
	t.Setenv("PATH", b)
	if got, err := Path(name); err == nil {
		t.Errorf("B has no such program, got %q", got)
	}
	if got, err := Path(fileA); err != nil || got != fileA {
		t.Errorf("a full path goes straight to exec.LookPath: %q %v", got, err)
	}
}

// A relative answer (a relative PATH entry under GODEBUG=execerrdot=0) is neither remembered nor started; and a name the standard library takes for a path is not a bare name.
func TestARelativeAnswerIsNotRemembered(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if err := os.Mkdir("tools", 0o755); err != nil {
		t.Fatal(err)
	}
	name := "zzlookpath-rel"
	tool(t, filepath.Join(dir, "tools"), name)
	t.Setenv("PATH", "tools")
	t.Setenv("GODEBUG", "execerrdot=0")
	got, err := Path(name)
	if err != nil || filepath.IsAbs(got) {
		t.Skipf("this Go answers a relative PATH entry with %q, %v: nothing to test", got, err)
	}
	memo.Lock()
	n := len(memo.m)
	_, kept := memo.m[os.Getenv("PATH")+"\x00"+os.Getenv("PATHEXT")+"\x00"+name]
	memo.Unlock()
	if kept {
		t.Errorf("a relative answer %q was remembered (%d entries)", got, n)
	}
}

func TestIsBare(t *testing.T) {
	for name, want := range map[string]bool{"git": true, "git.exe": true, "": false, `a\b`: false, "a/b": false, "./git": false} {
		if got := IsBare(name); got != want {
			t.Errorf("IsBare(%q) = %v, want %v", name, got, want)
		}
	}
	if runtime.GOOS == "windows" {
		for _, name := range []string{"C:git", "git.exe:stream"} {
			if IsBare(name) {
				t.Errorf("IsBare(%q) on Windows: a colon is path-like", name)
			}
		}
	}
}
