package sshprov

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
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
var standInNames = map[string]bool{"ssh": true}

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
		{[]string{"ssh2", "x"}, modeRefuse},
		{nil, modeRefuse},
	} {
		if got := binaryMode(tc.args); got != tc.want {
			t.Errorf("binaryMode(%v) = %d, want %d", tc.args, got, tc.want)
		}
	}
}

// standCfg is what one copy does. It lives in standin.json next to the copy.
type standCfg struct {
	Log      string `json:",omitempty"` // every argument is appended, one per line
	Stdout   string `json:",omitempty"`
	Stderr   string `json:",omitempty"`
	Exit     int    `json:",omitempty"`
	BigOut   int    `json:",omitempty"` // this many bytes of "x\n" on stdout, as `yes x | head -c N`
	EnvFile  string `json:",omitempty"` // the environment it was started with, one NAME=value per line
	TextFile string `json:",omitempty"` // the last argument, as it was given
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
	fmt.Fprint(os.Stdout, cfg.Stdout)
	if cfg.BigOut > 0 {
		os.Stdout.WriteString(strings.Repeat("x\n", cfg.BigOut/2+1)[:cfg.BigOut])
	}
	fmt.Fprint(os.Stderr, cfg.Stderr)
	return cfg.Exit
}
