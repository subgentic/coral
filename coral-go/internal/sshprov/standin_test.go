package sshprov

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// This test binary is also the stand-in for ssh (and, as the tests are ported, ssh-keyscan and the far computer), so the tests run the same on Windows, where there is no sh, tar or sha256sum to script
// (#11410). A test copies the binary to <dir>/ssh with newStandIn and writes what that copy should do next to it in standin.json.
//
// A copy is told apart from a test run BY ITS OWN NAME (os.Args[0] without .exe) and its arguments, never by a variable: a variable of ours would not survive minimalEnv, a child that took itself for
// a test run would start the suite again and each test would start another copy (#11377: 357, then 1,864 processes, three crashes of the operator's Mac). A copy never calls m.Run(), never starts a
// process of its own, and a start that is neither a go test start nor one of the known names exits 2 without running anything.
func TestMain(m *testing.M) {
	switch binaryMode(os.Args) {
	case modeStandIn:
		os.Exit(runStandIn())
	case modeRefuse:
		fmt.Fprintln(os.Stderr, "sshprov tests: this binary runs tests only under go test (-test. flags) and answers as ssh only under that name; nothing else")
		os.Exit(2)
	}
	os.Exit(m.Run())
}

const (
	modeTests   = iota // go test's own start: no arguments, or a -test. flag first, under a name that is not a stand-in's
	modeStandIn        // a copy of this binary named ssh: act as the configured stand-in, run no test
	modeRefuse         // anything else: run nothing, exit 2
)

// standInNames are the names a copy of this binary answers to.
var standInNames = map[string]bool{"ssh": true, "ssh-keyscan": true}

func standInName(arg0 string) string {
	return strings.TrimSuffix(strings.ToLower(path.Base(strings.ReplaceAll(arg0, `\`, "/"))), ".exe")
}

// binaryMode decides from the arguments alone. Pure: its test spawns nothing.
func binaryMode(args []string) int {
	switch {
	case len(args) == 0:
		return modeRefuse
	case standInNames[standInName(args[0])]:
		return modeStandIn
	case len(args) == 1, strings.HasPrefix(args[1], "-test."):
		return modeTests
	}
	return modeRefuse
}

func TestTheBinaryRunsTestsOnlyUnderGoTestAndIsAStandInOnlyUnderItsName(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want int
	}{
		{[]string{"sshprov.test"}, modeTests},
		{[]string{"sshprov.test.exe", "-test.v"}, modeTests},
		{[]string{"/x/sshprov.test", "-test.run=^TestX$", "-test.count=1"}, modeTests},
		{[]string{"/t/ssh", "-o", "BatchMode=yes", "--", "user@host", "uname"}, modeStandIn},
		{[]string{`C:\t\ssh.exe`, "-test.v"}, modeStandIn}, // by name first: a copy never runs the suite, whatever it is handed
		{[]string{"/t/SSH.EXE"}, modeStandIn},
		{[]string{"sshprov.test", "serve"}, modeRefuse},
		{[]string{"sshprov.test", "-v"}, modeRefuse},
		{[]string{"sshprov.test", "test.run=x"}, modeRefuse},
		{[]string{"sshprov.test", "", "-test.v"}, modeRefuse},
		{[]string{"/t/ssh-keyscan", "-p", "22", "box"}, modeStandIn},
		{[]string{"ssh2", "x"}, modeRefuse},
		{nil, modeRefuse},
	} {
		if got := binaryMode(tc.args); got != tc.want {
			t.Errorf("binaryMode(%v) = %d, want %d", tc.args, got, tc.want)
		}
	}
}

// maxStarts is the most a test may start one copy; the stream cap test holds 12, the rest start a handful.
const maxStarts = 100

// startsOverCap is the cap's decision, pure: starts holds one line per start (this one included), and the copy refuses when there are more than maxStarts.
func startsOverCap(starts []byte) bool { return strings.Count(string(starts), "\n") > maxStarts }

// standCfg is what one copy does. It lives in standin.json next to the copy.
type standCfg struct {
	Log      string `json:",omitempty"` // every argument is appended, one per line
	Stdout   string `json:",omitempty"`
	Stderr   string `json:",omitempty"`
	Exit     int    `json:",omitempty"`
	BigOut   int    `json:",omitempty"` // this many bytes of "x\n" on stdout, as `yes x | head -c N`
	EnvFile  string `json:",omitempty"` // the environment it was started with, one NAME=value per line
	TextFile string `json:",omitempty"` // the last argument, as it was given

	Pipe     bool `json:",omitempty"` // `-W host:port`: join stdin and stdout to that address, as ssh does over the channel
	HoldSecs int  `json:",omitempty"` // sleep this long (at most 60 s) before anything else, as a connection that stays open

	Far *farCfg `json:",omitempty"` // act as the far computer (farside_test.go): the last argument is the remote text

	// KnownHosts is written to the file named by a UserKnownHostsFile=<path> argument (what ssh does with a key it was told to accept), and that path to KnownHostsPath.
	KnownHosts     string `json:",omitempty"`
	KnownHostsPath string `json:",omitempty"`
}

// newStandIn puts a copy of this binary at <dir>/<name> with cfg beside it and returns its path.
func newStandIn(t *testing.T, name string, cfg standCfg) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	p := filepath.Join(dir, name)
	if err := os.Link(exe, p); err != nil {
		src, err := os.Open(exe)
		if err != nil {
			t.Fatal(err)
		}
		defer src.Close()
		dst, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY, 0o700)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(dst, src); err != nil {
			dst.Close()
			t.Fatal(err)
		}
		if err := dst.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if cfg.Far != nil {
		cfg.Far.TempRoot = os.TempDir()
	}
	b, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(dir, "standin.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// runStandIn acts as the configured stand-in and returns its exit code. It starts no process and runs no test.
func runStandIn() int {
	exe, err := os.Executable()
	if err != nil {
		return 2
	}
	var cfg standCfg
	b, err := os.ReadFile(filepath.Join(filepath.Dir(exe), "standin.json"))
	if err != nil || json.Unmarshal(b, &cfg) != nil {
		fmt.Fprintln(os.Stderr, "sshprov stand-in: no standin.json beside it")
		return 2
	}
	args := os.Args[1:]
	// a second line against a runaway: every start is one line in starts, and a copy started more than maxStarts times refuses (a loop of starts ends here, not in the process table)
	if f, err := os.OpenFile(filepath.Join(filepath.Dir(exe), "starts"), os.O_CREATE|os.O_APPEND|os.O_RDWR, 0o600); err == nil {
		fmt.Fprintln(f, "start")
		f.Seek(0, io.SeekStart)
		b, _ := io.ReadAll(f)
		f.Close()
		if startsOverCap(b) {
			fmt.Fprintln(os.Stderr, "sshprov stand-in: too many starts in one test")
			return 2
		}
	}
	if cfg.Log != "" {
		if f, err := os.OpenFile(cfg.Log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
			for _, a := range args {
				fmt.Fprintln(f, a)
			}
			f.Close()
		}
	}
	if cfg.EnvFile != "" {
		_ = os.WriteFile(cfg.EnvFile, []byte(strings.Join(os.Environ(), "\n")+"\n"), 0o600)
	}
	if cfg.TextFile != "" && len(args) > 0 {
		_ = os.WriteFile(cfg.TextFile, []byte(args[len(args)-1]), 0o600)
	}
	for _, a := range args {
		if f, ok := strings.CutPrefix(a, "UserKnownHostsFile="); ok && cfg.KnownHosts != "" {
			_ = os.WriteFile(f, []byte(cfg.KnownHosts), 0o600)
			if cfg.KnownHostsPath != "" {
				_ = os.WriteFile(cfg.KnownHostsPath, []byte(f), 0o600)
			}
		}
	}
	if cfg.Far != nil && len(args) > 0 {
		return runFar(*cfg.Far, strings.ReplaceAll(strings.TrimSuffix(strings.TrimPrefix(args[len(args)-1], "sh -c '"), "'"), `'\''`, "'"))
	}
	if cfg.HoldSecs > 0 {
		time.Sleep(time.Duration(min(cfg.HoldSecs, 60)) * time.Second)
	}
	if cfg.Pipe {
		for i, a := range args {
			if a == "-W" && i+1 < len(args) {
				c, err := net.Dial("tcp", args[i+1])
				if err != nil {
					return 255
				}
				go io.Copy(c, os.Stdin)
				io.Copy(os.Stdout, c)
				return 0
			}
		}
	}
	fmt.Fprint(os.Stdout, cfg.Stdout)
	if cfg.BigOut > 0 {
		os.Stdout.WriteString(strings.Repeat("x\n", cfg.BigOut/2+1)[:cfg.BigOut])
	}
	fmt.Fprint(os.Stderr, cfg.Stderr)
	return cfg.Exit
}

func TestFarSideWritesOnlyInsideTheTempFolder(t *testing.T) {
	root := os.TempDir()
	in := filepath.Join(t.TempDir(), "home")
	if !homeAllowed(in, root) {
		t.Errorf("a home in the temp folder was refused: %s", in)
	}
	for _, bad := range []string{"", "home", "/", os.TempDir(), "/etc", "/Users/x/.coral-server", in + "/../../x", in + "/", filepath.Join(os.TempDir(), "..", "x")} {
		if homeAllowed(bad, root) {
			t.Errorf("accepted %q", bad)
		}
	}
	if homeAllowed(in, "/") || homeAllowed(in, "") || homeAllowed(in, "tmp") {
		t.Error("a root that is not a real folder was taken")
	}
	if code := runFar(farCfg{Home: "/etc", TempRoot: root}, `rm -rf "$HOME/.coral-server"`); code != 2 {
		t.Errorf("runFar with a home outside the temp folder = %d", code)
	}
}

func TestAStandInStartedTooOftenRefuses(t *testing.T) {
	ssh := newStandIn(t, "ssh", standCfg{})
	tg, _ := ParseTarget("user@box.example.com")
	var last error
	for i := 0; i < maxStarts+5 && last == nil; i++ {
		res, err := (Runner{SSH: ssh}).Run(context.Background(), tg, CmdUname)
		if last = err; err == nil && res.ExitCode != 0 {
			last = errors.New("refused")
		}
	}
	if last == nil {
		t.Errorf("start %d still answered", maxStarts+5)
	}
}

// The cap's decision and the home guard's, pure, so each can be mutated (a > turned >=, a prefix check turned into a path check) and caught without running a start loop or a removal.
func TestStartsOverCapDecidesAtTheBoundary(t *testing.T) {
	lines := func(n int) []byte { return []byte(strings.Repeat("start\n", n)) }
	for n, want := range map[int]bool{0: false, 1: false, maxStarts - 1: false, maxStarts: false, maxStarts + 1: true, maxStarts * 10: true} {
		if got := startsOverCap(lines(n)); got != want {
			t.Errorf("%d starts: over = %v, want %v", n, got, want)
		}
	}
	if startsOverCap(nil) || startsOverCap([]byte("start")) {
		t.Error("an empty or unterminated log counted as over")
	}
}

func TestHomeAllowedIsInsideTheRootNotJustNamedLikeIt(t *testing.T) {
	root := t.TempDir()
	sibling := root + "-other" // shares the root's name as a prefix, is not inside it
	for home, want := range map[string]bool{
		filepath.Join(root, "home"):           true,
		filepath.Join(root, "a", "b", "home"): true,
		root:                                  false,
		filepath.Dir(root):                    false,
		filepath.Join(sibling, "home"):        false,
		filepath.Join(root, "..", "x"):        false,
		filepath.Join(root, "home") + string(filepath.Separator): false, // not clean
		"relative/home": false,
		"":              false,
	} {
		if got := homeAllowed(home, root); got != want {
			t.Errorf("homeAllowed(%q, %q) = %v, want %v", home, root, got, want)
		}
	}
	if runtime.GOOS != "windows" { // a link inside the root that points outside it
		outside := t.TempDir()
		if err := os.Symlink(outside, filepath.Join(root, "link")); err == nil && homeAllowed(filepath.Join(root, "link", "home"), root) {
			t.Error("a home reached through a link that leaves the root was allowed")
		}
	}
}
