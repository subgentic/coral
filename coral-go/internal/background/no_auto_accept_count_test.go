package background

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
)

// Auto-accept is the agent's CLI permission flag, which has no count: nothing enforced a limit on acceptances, so no
// field, map or document may offer one (#6917, #6916 point 4).
func TestNoAutoAcceptLimitIsOfferedAnywhere(t *testing.T) {
	root := filepath.Join("..", "..")
	offenders, err := autoAcceptOffenders(root, os.ReadFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range offenders {
		t.Error(o)
	}
}

// autoAcceptOffenders walks the tree under root and names every file that still offers an acceptance limit. It reads a tree other tests write into and remove from while it runs (a package's tests make and
// delete temp files and folders beside their sources), so a file or folder that is gone by the time it is reached is not an error and not a finding (#13490: it failed once in a full run and passed alone).
func autoAcceptOffenders(root string, readFile func(string) ([]byte, error)) ([]string, error) {
	gone := regexp.MustCompile(`\b(AutoAccept` + `(Limits|Counts|Sessions))\b`) // the maps are gone everywhere
	// The request field may be named only where it is refused and said so: the 400 for a caller who still sends it (#6937), its test and the doc row (and its synced copy).
	field := regexp.MustCompile(`\b(max_auto` + `_accepts|[mM]axAuto` + `Accepts)\b`)
	refusal := map[string]bool{"internal/server/routes/tasks.go": true, "internal/server/routes/tasks_no_auto_accept_count_test.go": true, "agent_docs/jobs.md": true, "pkg/frontend/static/agent_docs/jobs.md": true} // the synced copy the build embeds
	self := "no_auto_accept_count_test.go"
	var out []string
	walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if removedMidWalk(err, runtime.GOOS) { // removed under the walk
				if d != nil && d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "node_modules" || n == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		switch filepath.Ext(path) {
		case ".go", ".md", ".js", ".html":
		default:
			return nil
		}
		if d.Name() == self {
			return nil
		}
		b, err := readFile(path)
		if removedMidWalk(err, runtime.GOOS) { // listed, then removed before it was read
			return nil
		}
		if err != nil {
			return err
		}
		if w := gone.Find(b); w != nil {
			out = append(out, path+" still names \""+string(w)+"\"")
		}
		if w := field.Find(b); w != nil && !refusal[filepath.ToSlash(path[len(root)+1:])] {
			out = append(out, path+" still names \""+string(w)+"\"")
		}
		return nil
	})
	return out, walkErr
}

// removedMidWalk says whether err is what a file or folder removed (or being made or removed) under the walk gives. On Linux and macOS that is "does not exist". On Windows a file that is being created or deleted
// is still held open for a moment, so a read of it fails with a SHARING VIOLATION (32) or a LOCK VIOLATION (33), and a folder going away with ACCESS DENIED (5): the same event, a different word (#13490: windows-tests
// failed with "The process cannot access the file because it is being used by another process"). goos is a parameter so the rule is tested on every platform. Anything else is still an error.
func removedMidWalk(err error, goos string) bool {
	if errors.Is(err, fs.ErrNotExist) {
		return true
	}
	if goos != "windows" {
		return false
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case 32, 33, 5: // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_ACCESS_DENIED
			return true
		}
	}
	return false
}

func TestOnlyWindowsReadsASharingViolationAsRemovedMidWalk(t *testing.T) {
	wrap := func(e error) error { return &fs.PathError{Op: "open", Path: `C:\x\churn\c`, Err: e} }
	for _, e := range []syscall.Errno{32, 33, 5} {
		if !removedMidWalk(wrap(e), "windows") {
			t.Errorf("Windows error %d (a file mid-delete or mid-create) was an error", int(e))
		}
		if removedMidWalk(wrap(e), "linux") || removedMidWalk(wrap(e), "darwin") {
			t.Errorf("error %d is not a vanished file off Windows: it is another error there and must fail the walk", int(e))
		}
	}
	if !removedMidWalk(wrap(fs.ErrNotExist), "linux") || !removedMidWalk(wrap(fs.ErrNotExist), "windows") {
		t.Error("does not exist is a removed file everywhere")
	}
	if removedMidWalk(wrap(syscall.Errno(13)), "windows") || removedMidWalk(wrap(errors.New("disk on fire")), "windows") {
		t.Error("any other error still fails the walk")
	}
}

// #13490: a file or folder removed while the tree is walked is skipped, and an offender that stays is still found.
func TestTheAutoAcceptWalkIgnoresFilesRemovedMidWalk(t *testing.T) {
	root := t.TempDir()
	mk := func(name, body string) {
		t.Helper()
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("keep.go", "package x\n// fine\n")
	mk("tmp/vanishes.go", "package x\n")
	mk("offender.go", "package x\nvar AutoAccept"+"Limits = 1\n")
	// the file is listed by the walk and gone when it is read
	vanished := 0
	read := func(p string) ([]byte, error) {
		if strings.HasSuffix(filepath.ToSlash(p), "tmp/vanishes.go") {
			vanished++
			return nil, &fs.PathError{Op: "open", Path: p, Err: fs.ErrNotExist}
		}
		return os.ReadFile(p)
	}
	got, err := autoAcceptOffenders(root, read)
	if err != nil {
		t.Fatalf("a file removed under the walk failed it: %v", err)
	}
	if vanished != 1 {
		t.Fatalf("the vanishing file was read %d times", vanished)
	}
	if len(got) != 1 || !strings.Contains(got[0], "offender.go") {
		t.Fatalf("the offender that stays must be the one finding: %v", got)
	}

	// a real churn of temp files and folders beside the walk, as other tests make them
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			d := filepath.Join(root, "churn", string(rune('a'+i%20)))
			_ = os.MkdirAll(d, 0o755)
			_ = os.WriteFile(filepath.Join(d, "t.go"), []byte("package x\n"), 0o644)
			_ = os.RemoveAll(d)
		}
	}()
	for i := 0; i < 200; i++ {
		if _, err := autoAcceptOffenders(root, os.ReadFile); err != nil {
			close(stop)
			wg.Wait()
			t.Fatalf("walk %d failed under churn: %v", i, err)
		}
	}
	close(stop)
	wg.Wait()
}
