package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStartHeartbeatWritesAtOnceAndRemovesTheFileOnCancel(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	startHeartbeat(ctx, dir)
	path := filepath.Join(dir, "heartbeat")

	var data []byte
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
			data = b
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	fields := strings.Fields(string(data))
	if len(fields) != 2 || !strings.HasSuffix(string(data), "\n") {
		t.Fatalf("heartbeat = %q, want \"<unix> <pid>\\n\"", data)
	}
	if fields[1] != strconv.Itoa(os.Getpid()) {
		t.Errorf("heartbeat pid = %s, want %d", fields[1], os.Getpid())
	}
	if ts, err := strconv.ParseInt(fields[0], 10, 64); err != nil || time.Since(time.Unix(ts, 0)) > time.Minute {
		t.Errorf("heartbeat time = %q, want a recent unix time", fields[0])
	}

	cancel()
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the heartbeat file is still there after ctx ended")
}

func TestWaitForRestartedInstanceClearsTheVariable(t *testing.T) {
	for name, value := range map[string]string{
		"empty (nothing to clear)": "",
		"not a number":             "abc",
		"zero":                     "0",
		"negative":                 "-5",
		"a pid that is gone":       "2147483646",
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(restartWaitEnv, value)
			start := time.Now()
			waitForRestartedInstance()
			if v, ok := os.LookupEnv(restartWaitEnv); ok && v != "" {
				t.Errorf("%s = %q after the wait, want it cleared", restartWaitEnv, v)
			}
			if d := time.Since(start); d > 10*time.Second {
				t.Errorf("waited %v for a predecessor that does not exist", d)
			}
		})
	}
}

func TestStartWindowAtLaunchDecisionTable(t *testing.T) {
	log.SetOutput(&strings.Builder{})
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	for _, tc := range []struct {
		name                 string
		noBrowser, loginItem bool
		running              bool
		wantShown, wantAsked bool
	}{
		{"asked for, server running", false, false, true, true, true},
		{"asked for, server not running", false, false, false, false, true},
		{"--no-browser", true, false, true, false, false},
		{"login item", false, true, true, false, false},
		{"both", true, true, true, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shown := make(chan struct{}, 1)
			asked := false
			startWindowAtLaunch(tc.noBrowser, tc.loginItem, func() bool { asked = true; return tc.running }, func() { shown <- struct{}{} })
			select {
			case <-shown:
				if !tc.wantShown {
					t.Error("the window opened")
				}
			case <-time.After(300 * time.Millisecond):
				if tc.wantShown {
					t.Error("the window did not open")
				}
			}
			if asked != tc.wantAsked {
				t.Errorf("running() asked = %v, want %v (a start nobody asked for does not look at the server)", asked, tc.wantAsked)
			}
		})
	}
}

func TestSetupTrayLogWritesTheLogAndHandsTheFileToRedirect(t *testing.T) {
	dir := t.TempDir()
	prevOut, prevFlags := log.Writer(), log.Flags()
	t.Cleanup(func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) })

	var redirected []*os.File
	setupTrayLog(dir, func(f *os.File) { redirected = append(redirected, f) })
	if len(redirected) == 0 {
		t.Fatal("redirect was not called with the log file")
	}
	home, _ := os.UserHomeDir()
	log.Printf("hello from the tray test %s", filepath.Join(home, "x"))
	b, err := os.ReadFile(filepath.Join(dir, "tray.log"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	if !strings.Contains(got, "hello from the tray test") {
		t.Errorf("tray.log = %q, want the logged line", got)
	}
	if home != "" && strings.Contains(got, home) {
		t.Errorf("tray.log holds the home folder %q: %q", home, got)
	}
	// Windows has no file mode bits to check: Go reports 0666 for any file that is not read-only (the log is created 0600 where there are bits).
	if fi, err := os.Stat(filepath.Join(dir, "tray.log")); runtime.GOOS != "windows" && err == nil && fi.Mode().Perm()&0o077 != 0 {
		t.Errorf("tray.log mode = %v, want 0600", fi.Mode().Perm())
	}
	_ = fmt.Sprint
}
