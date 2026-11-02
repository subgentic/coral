package main

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
)

// stderrOf runs f with os.Stderr captured: subcommand writes to the process's own.
func stderrOf(t *testing.T, f func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stderr
	os.Stderr = w
	done := make(chan string)
	go func() { b, _ := io.ReadAll(r); done <- string(b) }()
	func() {
		defer func() { os.Stderr = old; w.Close() }()
		f()
	}()
	return <-done
}

// `coral machine` is off by default (#9934 slice 1b): with the flag unset it is an unknown command (exit 2, said so on stderr, no usage of launch), not in the help and not found by `coral help machine`. subcommand answers ok=true
// for ANY bare word (the unknown-command report), so the exit code and the output are what tell.
func TestMachineIsOffByDefault(t *testing.T) {
	t.Setenv(machineLaunchEnvVar, "")
	for _, args := range [][]string{{"machine"}, {"machine", "launch"}, {"machine", "list"}, {"machine", "delete", "x"}, {"machine", "prune"}, {"machine", "egress-files"}} {
		var code int
		var ok bool
		got := stderrOf(t, func() { code, ok = subcommand(args) })
		if !ok || code != 2 || !strings.Contains(got, `unknown command "machine"`) || strings.Contains(got, "coral machine launch") {
			t.Errorf("%v: code %d ok %v, stderr %q: want the unknown-command report and no machine usage while the flag is off", args, code, ok, got)
		}
	}
	var out bytes.Buffer
	printHelp(&out)
	if strings.Contains(out.String(), "  machine ") {
		t.Errorf("the help lists machine while the flag is off")
	}
	if printCommandHelp(&out, "machine") {
		t.Errorf("coral help machine found it")
	}
	if _, found := findCommand("machine"); found {
		t.Errorf("findCommand found it")
	}
}

func TestMachineIsOnWithTheFlag(t *testing.T) {
	for _, v := range []string{"0", "false", "off", "no", "garbage"} {
		t.Setenv(machineLaunchEnvVar, v)
		var code int
		got := stderrOf(t, func() { code, _ = subcommand([]string{"machine"}) })
		if code != 2 || !strings.Contains(got, `unknown command "machine"`) {
			t.Errorf("%q is not on: code %d, stderr %q", v, code, got)
		}
	}
	t.Setenv(machineLaunchEnvVar, "1")
	var code int
	var ok bool
	got := stderrOf(t, func() { code, ok = subcommand([]string{"machine"}) }) // no subcommand: the machine usage, exit 2, and nothing reaches a provider
	if !ok || code != 2 || strings.Contains(got, "unknown command") || !strings.Contains(got, "usage: coral machine launch") {
		t.Errorf("on: code %d ok %v, stderr %q", code, ok, got)
	}
	var out bytes.Buffer
	printHelp(&out)
	if !strings.Contains(out.String(), "  machine ") {
		t.Errorf("the help does not list machine while the flag is on")
	}
}
