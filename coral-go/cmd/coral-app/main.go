//go:build webview

// Command coral-app opens the Coral dashboard in a native webview window.
//
// This is a lightweight wrapper around webview/webview_go that displays
// the Coral web dashboard without browser chrome (no URL bar, no tabs).
// The server must be running separately (via coral or coral-tray).
//
// Usage:
//
//	coral-app                             # Open dashboard at default URL
//	coral-app --url http://localhost:9000  # Custom server URL
//	coral-app --width 1400 --height 900   # Custom window size
//	coral-app --debug                     # Enable debug logging to app.log in the data folder
package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/subgentic/coral/internal/logsafe"
	"log"
	"net/http"
	neturl "net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"syscall"
	"time"

	webview "github.com/webview/webview_go"

	"github.com/subgentic/coral/internal/appdownload"
	"github.com/subgentic/coral/internal/apptoken"
	"github.com/subgentic/coral/internal/config"
	_ "github.com/subgentic/coral/internal/dllpreload" // the webview's bare-name DLL loads find the system folder's modules (#5724)
	"github.com/subgentic/coral/internal/executil"
	"github.com/subgentic/coral/internal/loginlink"
	"github.com/subgentic/coral/internal/logrotate"
)

var debugMode bool

// webviewInstance holds the webview reference for signal-triggered shutdown.
// Set after webview creation so the signal handler can call Terminate()
// instead of os.Exit, allowing deferred cleanup (webview.Destroy) to run.
var webviewInstance webview.WebView

// init locks the main goroutine to OS thread 0 before any scheduling.
// This must happen in init(), not main(), because Go may reschedule the
// main goroutine to a different OS thread before main() runs. macOS
// Cocoa/WKWebView requires thread 0.
func init() {
	runtime.LockOSThread()
}

func main() {

	cfg := parseAppFlags(flag.CommandLine, os.Args[1:])
	// A sign-in link handed over by the tray (#3394), in the environment so no other user can
	// read it with ps. Used once: drop it so nothing this window starts inherits it.
	handedLink := os.Getenv("CORAL_APP_LOGIN_URL")
	os.Unsetenv("CORAL_APP_LOGIN_URL")

	debugMode = cfg.debug || os.Getenv("CORAL_DEBUG") == "1"

	// Always log to file so we catch crashes — debug mode adds JS console redirect
	setupDebugLogging(cfg.dataDir)

	// Check EULA acceptance before proceeding. On macOS, this shows a native
	// Cocoa dialog on first launch. If the user declines, the app exits.
	if !checkAndShowEULA() {
		fmt.Fprintln(os.Stderr, "Terms of Service must be accepted to use Coral.")
		os.Exit(0)
	}

	// Global panic recovery — log the stack trace before crashing
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[FATAL] panic recovered: %v", r)
			log.Printf("[FATAL] stack trace:\n%s", debug.Stack())
			os.Exit(1)
		}
	}()

	// Ignore SIGHUP — macOS sends it during sleep/wake transitions
	signal.Ignore(syscall.SIGHUP)

	// Catch SIGTERM/SIGINT for clean shutdown — terminate the webview event
	// loop so deferred Destroy() runs, preventing leaked WKWebView processes.
	watchTerminationSignals(func() terminator {
		if w := webviewInstance; w != nil {
			return w
		}
		return nil
	}, os.Exit)

	log.Printf("[STARTUP] coral-app starting pid=%d", os.Getpid())
	log.Printf("[STARTUP] args=%v", os.Args)
	log.Printf("[STARTUP] go=%s os=%s arch=%s goroutines=%d", runtime.Version(), runtime.GOOS, runtime.GOARCH, runtime.NumGoroutine())
	log.Printf("[STARTUP] url=%s title=%s size=%dx%d wait=%v debug=%v", cfg.url, cfg.title, cfg.width, cfg.height, cfg.wait, debugMode)

	// Optionally wait for the server to be ready
	if cfg.wait {
		log.Printf("[STARTUP] waiting for server at %s...", cfg.url)
		if !waitForServer(cfg.url, 15*time.Second) {
			log.Printf("[STARTUP] server not responding after 15s — exiting")
			fmt.Fprintf(os.Stderr, "Server at %s is not responding. Is Coral running?\n", cfg.url)
			os.Exit(1)
		}
		log.Println("[STARTUP] server is ready")
	}

	// Sign in without the API key or a prompt (#3394): the link the tray handed over, or a
	// fresh one from this computer's Coral. Without one (an older Coral) the URL itself opens.
	startURL := chooseStartURL(handedLink, cfg.url, cfg.dataDir, loginlink.FromCLI)

	log.Println("[WEBVIEW] calling showInDock()")
	showInDock()
	log.Println("[WEBVIEW] showInDock() dispatched")

	log.Println("[WEBVIEW] installing Edit menu")
	installEditMenu()
	log.Println("[WEBVIEW] Edit menu dispatched")

	// DevTools give script access to the signed-in dashboard: only a dev build opens them, whatever --debug or CORAL_DEBUG
	// say (they switch the debug LOG on in every build, #78 W2).
	devTools := debugMode && config.TierDevTools
	// WebView2's profile (the dashboard's sign-in cookie) belongs on this computer, not in the Roaming folder: set before the window exists.
	if useLocalWebViewProfile() != "" {
		log.Println("[WEBVIEW] the profile is in a local folder (not the Roaming folder)") // no path: the log carries no user name
	}
	log.Printf("[WEBVIEW] creating webview (devtools=%v)", devTools)
	w := webview.New(devTools)
	webviewInstance = w
	log.Println("[WEBVIEW] webview created successfully")
	defer func() {
		log.Println("[WEBVIEW] destroying webview")
		w.Destroy()
		log.Println("[WEBVIEW] webview destroyed")
	}()

	log.Printf("[WEBVIEW] setting title=%q size=%dx%d", cfg.title, cfg.width, cfg.height)
	installFilePanel(w.Window()) // a file input opens the system chooser (#5743)
	w.SetTitle(cfg.title)
	workW, workH := workArea()
	fw, fh := fitSize(cfg.width, cfg.height, workW, workH)
	if fw != cfg.width || fh != cfg.height {
		log.Printf("[WEBVIEW] the screen's work area cannot hold %dx%d: opening at %dx%d", cfg.width, cfg.height, fw, fh)
	}
	w.SetSize(fw, fh, webview.HintNone)
	placeInWorkArea(w.Window()) // the cascade can put the window partly off a small screen (#6004 W5)

	// Configure native title bar (macOS: transparent, content extends into title bar)
	log.Println("[WEBVIEW] setting up native titlebar")
	setupNativeTitlebar()
	log.Println("[WEBVIEW] titlebar setup complete")

	// Inject native app flag and apply classes SYNCHRONOUSLY on <html> element.
	// documentElement exists before CSS is evaluated, ensuring -webkit-app-region: drag
	// and WKWebView layout fixes are active from the first layout pass.
	// Also applies on <body> at DOMContentLoaded as a safety net.
	log.Println("[WEBVIEW] injecting native app JS (class flags, external link handler)")
	w.Init(logHintScript(config.ResolveCoralDir(cfg.dataDir)))
	// documentElement and body can be null where the script runs (a blank first page): each is marked only when it exists, and again at DOMContentLoaded.
	w.Init(nativeAppScript)

	// What a link may do in this window (#5094): see linkInterceptScript.
	w.Init(linkInterceptScript)
	w.Init(downloadInterceptScript)
	w.Init(titlebarFollowScript)

	// The native functions are bound on every page the window shows and the Go side is not told the page's origin, so each takes a
	// per-launch token first and refuses a call without it. Only an init script that runs on the dashboard's origin hands the
	// token to the page-facing shims (apptoken, #78 W1): a page of another origin cannot call them, even through
	// window.chrome.webview.postMessage. The check here, not the deleting of shims off-origin, is the boundary.
	guard, gerr := apptoken.New()
	if gerr != nil {
		log.Fatalf("[FATAL] cannot make the window's call token: %v", gerr)
	}
	refused := func(name string) {
		log.Printf("[WEBVIEW] refused a call to %s without this window's token (a page that is not the dashboard)", name)
	}
	natives := []apptoken.Native{
		{Page: "_coralOpenExternal", Native: "__coralNativeOpenExternal"},
		{Page: "_coralAppSignIn", Native: "__coralNativeAppSignIn"},
		{Page: "_coralTitlebar", Native: "__coralNativeTitlebar"},
		{Page: "_coralSaveFile", Native: "__coralNativeSaveFile"},
	}

	// Bind native URL opener — WKWebView doesn't support window.open(),
	// so the link interceptor calls this to open external URLs in the system browser.
	// The binding is callable by whatever page the window shows, and the system's opener runs files and starts custom
	// schemes: only a plain http or https address goes through (executil.WebURL).
	w.Bind("__coralNativeOpenExternal", func(token, raw string) {
		if !guard.Allowed(token) {
			refused("openExternal")
			return
		}
		if !executil.OpenWebURL(raw) {
			log.Printf("[WEBVIEW] refused to open an address that is not a plain http or https URL (%d bytes)", len(raw))
			return
		}
		log.Printf("[WEBVIEW] opening external URL: %s", loginlink.Redact(raw))
	})

	// A download the webview would drop (WKWebView ignores <a download> and blob: addresses): the page's script (downloadInterceptScript) reads the
	// bytes and hands them here; the file goes into the person's Downloads folder under a safe name that never replaces one already there (#9894).
	w.Bind("__coralNativeSaveFile", func(token, name, contentB64 string) (string, error) {
		if !guard.Allowed(token) {
			refused("saveFile")
			return "", fmt.Errorf("refused")
		}
		dir, err := appdownload.DownloadsDir()
		if err != nil {
			log.Printf("[WEBVIEW] download: no Downloads folder: %v", err)
			return "", err
		}
		path, err := appdownload.Save(dir, name, contentB64)
		if err != nil {
			log.Printf("[WEBVIEW] download of %q refused: %v", appdownload.SafeName(name), err)
			return "", err
		}
		log.Printf("[WEBVIEW] saved a download: %s", logsafe.Path(path))
		return path, nil
	})

	// The title bar follows the page's theme: the page reports the colours of --bg-primary and --border (see titlebarFollowScript) and the native side
	// checks that they are colours before it paints the caption with them.
	w.Bind("__coralNativeTitlebar", func(token, bg, border string) {
		if !guard.Allowed(token) {
			refused("titlebar")
			return
		}
		w.Dispatch(func() { setTitlebarColors(bg, border) })
	})

	// Bind JS console.log to Go logger in debug mode
	log.Println("[WEBVIEW] setting up JS console redirect and WS monitoring")
	if debugMode {
		w.Bind("__coralNativeLog", func(token, level, msg string) {
			if !guard.Allowed(token) {
				refused("log")
				return
			}
			log.Printf("[JS %s] %s", level, msg)
		})
		natives = append(natives, apptoken.Native{Page: "_coralLog", Native: "__coralNativeLog"})

		// Inject JS that redirects console.log/warn/error to Go
		w.Init(consoleRedirectScript)

		log.Printf("Navigating to %s", loginlink.Redact(startURL))
	}

	// The session ended (or the server restarted with a new one) and the dashboard shows its
	// sign-in page: ask Coral for a fresh link and sign in again, without a prompt. Only for
	// this Coral's own sign-in page, and at most once every 30 s, so a page that keeps
	// answering 403 can't loop. The link never reaches the page's script. It lands on the page
	// the sign-in page was asked for (its return_to), when that is a page of this dashboard (#3532).
	baseOrigin := originOf(cfg.url)
	var signIn signInThrottle
	w.Bind("__coralNativeAppSignIn", func(token, page string) {
		if !guard.Allowed(token) {
			refused("appSignIn")
			return
		}
		if !signIn.allow(time.Now()) {
			return
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			link, err := loginlink.FromCLI(ctx, cfg.url, config.ResolveCoralDir(cfg.dataDir))
			if err != nil {
				log.Printf("[WEBVIEW] sign-in page shown; no new sign-in link: %v", err)
				return
			}
			link = loginlink.MarkApp(loginlink.OnPage(link, page))
			log.Printf("[WEBVIEW] sign-in page shown; signing in again at %s", loginlink.Redact(link))
			w.Dispatch(func() { w.Navigate(link) })
		}()
	})
	// The page-facing functions (_coralOpenExternal, _coralAppSignIn, _coralLog), which add the token, exist only on the
	// dashboard's origin (apptoken.ShimScript). Registered after the Binds and BEFORE the sign-in call below, so the shim is there when
	// that script runs. A native navigation allowlist (WebView2 NavigationStarting) and a dashboard CSP are still wanted (#78 W1):
	// webview_go does not expose the first.
	w.Init(guard.ShimScript(baseOrigin, natives))
	w.Init(fmt.Sprintf(`(function(){ if (location.origin === %q && location.pathname === '/auth' && window._coralAppSignIn) window._coralAppSignIn(new URLSearchParams(location.search).get('return_to') || '/'); })();`, baseOrigin))

	log.Printf("[WEBVIEW] navigating to %s", loginlink.Redact(startURL))
	w.Navigate(startURL)

	watchEndSession(w.Terminate)
	log.Printf("[WEBVIEW] starting event loop (goroutines=%d)", runtime.NumGoroutine())
	w.Run()
	log.Printf("[WEBVIEW] event loop exited (goroutines=%d)", runtime.NumGoroutine())
	log.Println("[SHUTDOWN] coral-app exiting normally")
}

// setupDebugLogging redirects log output to app.log in Coral's data folder (--data-dir,
// else the usual one: CORAL_DATA_DIR, CORAL_DIR or ~/.coral), so a window for another
// Coral logs with that Coral (#3463).
func setupDebugLogging(dataDir string) {
	logDir := config.ResolveCoralDir(dataDir)
	os.MkdirAll(logDir, 0o700)
	logFile := filepath.Join(logDir, "app.log")
	// Rotates as coral.log does (#4112): 0600, no symlink followed, 20 MB x 5.
	f, err := logrotate.Open(logFile, logrotate.DefaultMaxSize, logrotate.DefaultKeep, logrotate.DefaultTrim)
	if err != nil {
		return
	}
	log.SetOutput(logsafe.Writer(f)) // no home folder, user or computer name in app.log (#6053)
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	fmt.Fprintf(os.Stderr, "Debug logging to %s\n", logFile)
}

// waitForServer polls the server URL until it responds or timeout is reached.
func waitForServer(url string, timeout time.Duration) bool {
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

// originOf returns the scheme://host[:port] of raw, as the page sees location.origin.
func originOf(raw string) string {
	u, err := neturl.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// titlebarFollowScript reports the page's theme colours to the native title bar (the page-facing _coralTitlebar exists only on the dashboard's origin): once the page is
// ready, and again whenever the theme changes (data-theme, a custom theme's inline variables, or the system's mode when the choice is System).
const titlebarFollowScript = `(function() {
	var timer = null;
	function push() {
		if (typeof window._coralTitlebar !== 'function' || !document.body) return;
		var cs = getComputedStyle(document.body);
		window._coralTitlebar(cs.getPropertyValue('--bg-primary').trim(), cs.getPropertyValue('--border').trim());
	}
	function later() { clearTimeout(timer); timer = setTimeout(push, 60); }
	document.addEventListener('DOMContentLoaded', function() {
		push();
		var opts = { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] };
		new MutationObserver(later).observe(document.documentElement, opts);
		new MutationObserver(later).observe(document.body, opts);
		try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', later); } catch (e) {}
	});
})();`
