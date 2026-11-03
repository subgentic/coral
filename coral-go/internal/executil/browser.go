package executil

import (
	"fmt"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// OpenBrowser opens url in the user's browser. Only a plain http or https address (WebURL) is
// handed to the system's opener, which would otherwise open or run a file or start a custom
// scheme's handler (#78 T1); anything else is not opened. A file Coral wants shown (its log) goes
// through OpenFile.
func OpenBrowser(url string) {
	u, ok := WebURL(url)
	if !ok {
		return
	}
	startOpener(browserCommand(runtime.GOOS, u))
}

// startOpener runs the system's opener with argv (a test seam) and reports whether it started.
var startOpener = func(argv []string) bool {
	cmd := exec.Command(argv[0], argv[1:]...)
	if runtime.GOOS == "windows" {
		HideWindow(cmd)
	}
	return cmd.Start() == nil
}

// OpenLogin opens a sign-in link in the user's browser without putting the link in an argument list (#12546, Security #3970): every account on the computer can read a process's arguments, and the
// link is the one secret in a browser launch. The opener is given a small page that only redirects to the link, written for its owner alone (0600, in the user's temp folder), so what the
// argument list shows is a file's name. A link is single use and lasts ten minutes, so the page is harmless once it has been followed, and any left behind are removed on the next call. An
// address with no secret in it, or a page that cannot be written, is opened as OpenBrowser does.
func OpenLogin(link string) {
	u, ok := WebURL(link)
	if !ok {
		return
	}
	if !strings.Contains(u, "login_token=") {
		OpenBrowser(u)
		return
	}
	if path, err := writeLoginPage(u); err == nil && startOpener(fileOpenCommand(runtime.GOOS, path)) {
		return
	}
	OpenBrowser(u)
}

// fileOpenCommand is the argv that opens the file at path in its default program on goos (the browser, for a page).
func fileOpenCommand(goos, path string) []string {
	switch goos {
	case "darwin":
		return []string{"open", path}
	case "windows":
		return []string{systemRundll32(), "url.dll,FileProtocolHandler", path}
	default:
		return []string{"xdg-open", path}
	}
}

const loginPagePrefix = "coral-signin-"

// writeLoginPage writes the redirect page for link and returns its path. It first removes the ones older than the link's lifetime.
func writeLoginPage(link string) (string, error) {
	dir := os.TempDir()
	if old, _ := filepath.Glob(filepath.Join(dir, loginPagePrefix+"*.html")); len(old) > 0 {
		for _, f := range old {
			if fi, err := os.Lstat(f); err == nil && fi.Mode().IsRegular() && time.Since(fi.ModTime()) > 10*time.Minute {
				os.Remove(f)
			}
		}
	}
	f, err := os.CreateTemp(dir, loginPagePrefix+"*.html") // 0600
	if err != nil {
		return "", err
	}
	defer f.Close()
	if err := f.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		os.Remove(f.Name())
		return "", err
	}
	esc := html.EscapeString(link)
	_, err = fmt.Fprintf(f, `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=%s"><title>Opening Coral</title></head><body><p>Opening Coral. If nothing happens, <a href="%s" rel="noreferrer">open the dashboard</a>.</p></body></html>`, esc, esc)
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// setOpenerForTest replaces the opener and returns the restore.
func setOpenerForTest(f func(argv []string) bool) (restore func()) {
	old := startOpener
	startOpener = f
	return func() { startOpener = old }
}

// browserCommand is the argv that opens url on goos. On Windows the URL goes to the URL
// protocol handler directly, never through cmd.exe, which would read '&' or '|' in it as a
// command separator (#3690, #3689 finding 3). The handler is named by its absolute path in the
// system folder, so a rundll32 elsewhere on PATH is never the one started (#78 T1).
func browserCommand(goos, url string) []string {
	switch goos {
	case "darwin":
		return []string{"open", url}
	case "windows":
		return []string{systemRundll32(), "url.dll,FileProtocolHandler", url}
	default:
		return []string{"xdg-open", url}
	}
}

// insideDir reports whether path, cleaned, is below dir, cleaned (case-insensitive on Windows, where file names are).
func insideDir(dir, path string) bool {
	dir, path = filepath.Clean(dir), filepath.Clean(path)
	if runtime.GOOS == "windows" {
		dir, path = strings.ToLower(dir), strings.ToLower(path)
	}
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// openableFileExts are the files OpenFile shows: Coral's own logs.
var openableFileExts = map[string]bool{".log": true, ".txt": true}

// OpenFile shows a log file Coral wrote (the tray's "Open Log") in the system's default program:
// a regular file inside dir (Coral's data folder) with a .log or .txt extension, never a link, a
// program or a script, and nothing outside dir (the opener runs what it is given, #78 T1). path and
// dir must be absolute. It reports whether it started the opener.
func OpenFile(dir, path string) bool {
	if dir == "" || path == "" || !filepath.IsAbs(dir) || !filepath.IsAbs(path) || strings.HasPrefix(path, "-") ||
		!openableFileExts[strings.ToLower(filepath.Ext(path))] || !insideDir(dir, path) {
		return false
	}
	if fi, err := os.Lstat(path); err != nil || !fi.Mode().IsRegular() {
		return false
	}
	var argv []string
	switch runtime.GOOS {
	case "darwin":
		argv = []string{"open", "-t", path}
	case "windows":
		argv = []string{systemRundll32(), "url.dll,FileProtocolHandler", path}
	default:
		argv = []string{"xdg-open", path}
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	if runtime.GOOS == "windows" {
		HideWindow(cmd)
	}
	return cmd.Start() == nil
}
