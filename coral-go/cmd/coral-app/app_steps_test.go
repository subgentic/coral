//go:build webview

package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/loginlink"
)

func quietLog(t *testing.T) {
	t.Helper()
	prev := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(prev) })
}

func TestParseAppFlagsDefaultsAndOverrides(t *testing.T) {
	newFS := func() *flag.FlagSet {
		fs := flag.NewFlagSet("coral-app", flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		return fs
	}
	got := parseAppFlags(newFS(), nil)
	want := appFlags{url: "http://localhost:8420", title: "Coral", width: 1200, height: 800}
	if got != want {
		t.Errorf("defaults = %+v, want %+v", got, want)
	}
	got = parseAppFlags(newFS(), []string{"--url", "http://localhost:9000", "--title", "T", "--width", "1400", "--height", "900", "--wait", "--debug", "--data-dir", "/x"})
	want = appFlags{url: "http://localhost:9000", title: "T", width: 1400, height: 900, wait: true, debug: true, dataDir: "/x"}
	if got != want {
		t.Errorf("overrides = %+v, want %+v", got, want)
	}
}

func TestChooseStartURL(t *testing.T) {
	quietLog(t)
	const server = "http://localhost:8420"
	handed := "http://localhost:8420/auth?" + loginlink.Param + "=tok"
	fresh := "http://localhost:8420/auth?" + loginlink.Param + "=fresh"
	asks := 0
	fromCLI := func(ctx context.Context, url, dir string) (string, error) {
		asks++
		if url != server {
			t.Errorf("asked for a link of %q, want %q", url, server)
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Error("the ask has no deadline")
		}
		return fresh, nil
	}
	failing := func(context.Context, string, string) (string, error) { return "", errors.New("no coral") }

	t.Run("a handed link with a token is used, and asks nothing", func(t *testing.T) {
		asks = 0
		got := chooseStartURL(handed, server, "", fromCLI)
		if got != loginlink.MarkApp(handed) || asks != 0 {
			t.Errorf("got %q after %d asks, want the handed link marked as the app's", got, asks)
		}
	})
	t.Run("no link asks this computer's Coral", func(t *testing.T) {
		asks = 0
		if got := chooseStartURL("", server, "", fromCLI); got != loginlink.MarkApp(fresh) || asks != 1 {
			t.Errorf("got %q after %d asks", got, asks)
		}
	})
	t.Run("a handed link without a token is replaced", func(t *testing.T) {
		asks = 0
		if got := chooseStartURL(server+"/", server, "", fromCLI); got != loginlink.MarkApp(fresh) || asks != 1 {
			t.Errorf("got %q after %d asks", got, asks)
		}
	})
	t.Run("an older Coral that makes no link opens the address itself", func(t *testing.T) {
		if got := chooseStartURL("", server, "", failing); got != server {
			t.Errorf("got %q, want %q", got, server)
		}
	})
	t.Run("the link is marked as the app's", func(t *testing.T) {
		if got := chooseStartURL(handed, server, "", fromCLI); !strings.Contains(got, loginlink.AppParam+"="+loginlink.AppValue) {
			t.Errorf("got %q, want the %s mark", got, loginlink.AppParam)
		}
	})
}

func TestSignInThrottleAllowsOneEveryThirtySeconds(t *testing.T) {
	var th signInThrottle
	t0 := time.Now()
	if !th.allow(t0) {
		t.Fatal("the first ask was refused")
	}
	if th.allow(t0.Add(29 * time.Second)) {
		t.Error("an ask 29 s later was allowed")
	}
	if !th.allow(t0.Add(30 * time.Second)) {
		t.Error("an ask 30 s later was refused")
	}
	if th.allow(t0.Add(31 * time.Second)) {
		t.Error("the window starts again from the last allowed ask")
	}
}

type fakeWindow struct{ ended bool }

func (f *fakeWindow) Terminate() { f.ended = true }

func TestShutdownOnEndsTheWindowOrTheProcess(t *testing.T) {
	quietLog(t)
	w := &fakeWindow{}
	code := -1
	shutdownOn(syscall.SIGTERM, func() terminator { return w }, func(c int) { code = c })
	if !w.ended || code != -1 {
		t.Errorf("with a window: terminated=%v exit=%d, want the window ended and no exit", w.ended, code)
	}
	shutdownOn(syscall.SIGINT, func() terminator { return nil }, func(c int) { code = c })
	if code != 1 {
		t.Errorf("without a window: exit = %d, want 1", code)
	}
}

func TestWaitForServerAndOriginOf(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	if !waitForServer(srv.URL, 5*time.Second) {
		t.Error("a running server was not found")
	}
	url := srv.URL
	srv.Close()
	if waitForServer(url, 700*time.Millisecond) {
		t.Error("a stopped server was found")
	}
	for in, want := range map[string]string{
		"http://localhost:8420/auth?x=1": "http://localhost:8420",
		"https://example.test/a/b":       "https://example.test",
		"://bad":                         "",
	} {
		if got := originOf(in); got != want {
			t.Errorf("originOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSetupDebugLoggingWritesAppLogInTheDataFolder(t *testing.T) {
	dir := t.TempDir()
	prevOut, prevFlags := log.Writer(), log.Flags()
	t.Cleanup(func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) })
	setupDebugLogging(dir)
	log.Print("a line for app.log")
	b, err := os.ReadFile(dir + "/app.log")
	if err != nil || !strings.Contains(string(b), "a line for app.log") {
		t.Fatalf("app.log = %q, %v", b, err)
	}
}
