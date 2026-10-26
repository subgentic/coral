//go:build webview

package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/loginlink"
)

// appFlags are the command line's settings.
type appFlags struct {
	url, title string
	width      int
	height     int
	wait       bool
	debug      bool
	dataDir    string
}

// parseAppFlags reads the command line into fs (flag.CommandLine in the app; a flag error ends the process there, as flag.ExitOnError says).
func parseAppFlags(fs *flag.FlagSet, args []string) appFlags {
	var c appFlags
	fs.StringVar(&c.url, "url", "http://localhost:8420", "Coral server URL")
	fs.StringVar(&c.title, "title", "Coral", "Window title")
	fs.IntVar(&c.width, "width", 1200, "Window width")
	fs.IntVar(&c.height, "height", 800, "Window height")
	fs.BoolVar(&c.wait, "wait", false, "Wait for server to be ready before opening")
	fs.BoolVar(&c.debug, "debug", false, "Enable debug logging to app.log in the data folder")
	fs.StringVar(&c.dataDir, "data-dir", "", "Coral's data folder, to ask it for a sign-in link (default: the usual one)")
	fs.Parse(args)
	return c
}

// chooseStartURL is the page the window opens: the sign-in link the tray handed over when it carries a token, else a fresh one from this computer's Coral (fromCLI), else the
// server's own address (an older Coral has no link to make). The session the link makes is named "Coral app on ..." on the Sessions page (#6100).
func chooseStartURL(handedLink, serverURL, dataDir string, fromCLI func(ctx context.Context, url, coralDir string) (string, error)) string {
	startURL := handedLink
	if startURL == "" || !loginlink.HasToken(startURL) {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		link, err := fromCLI(ctx, serverURL, config.ResolveCoralDir(dataDir))
		cancel()
		if err != nil {
			log.Printf("[STARTUP] no sign-in link (%v); opening %s", err, serverURL)
			startURL = serverURL
		} else {
			startURL = link
		}
	}
	return loginlink.MarkApp(startURL)
}

// signInThrottle lets a page ask for a new sign-in at most once every 30 seconds, so a page that keeps answering 403 cannot loop.
type signInThrottle struct {
	mu   sync.Mutex
	last time.Time
}

func (t *signInThrottle) allow(now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if now.Sub(t.last) < 30*time.Second {
		return false
	}
	t.last = now
	return true
}

// terminator is the window's event loop, which a signal ends so the deferred Destroy runs.
type terminator interface{ Terminate() }

// watchTerminationSignals makes SIGTERM and SIGINT end the window's event loop (so no WKWebView process leaks), or the process when there is no window yet. window returns nil until
// the window exists.
func watchTerminationSignals(window func() terminator, exit func(int)) {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() { shutdownOn(<-sigCh, window, exit) }()
}

func shutdownOn(sig os.Signal, window func() terminator, exit func(int)) {
	log.Printf("[SHUTDOWN] received signal: %v", sig)
	log.Printf("[SHUTDOWN] goroutines: %d", runtime.NumGoroutine())
	if w := window(); w != nil {
		log.Println("[SHUTDOWN] terminating webview event loop")
		w.Terminate()
	} else {
		log.Println("[SHUTDOWN] no webview yet, exiting")
		exit(1)
	}
}
