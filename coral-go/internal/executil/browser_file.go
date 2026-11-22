package executil

// A separate boundary from TryOpenBrowser: only the local Operator route may
// open a checked project file. Association command lines are never interpreted.
import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
)

var ErrUnknownBrowser = errors.New("Coral does not know your default browser; open the file yourself")

var browserIDs = map[string]map[string]string{
	"darwin":  {"com.apple.Safari": "com.apple.Safari", "com.google.Chrome": "com.google.Chrome", "com.microsoft.edgemac": "com.microsoft.edgemac", "org.mozilla.firefox": "org.mozilla.firefox", "com.brave.Browser": "com.brave.Browser", "org.chromium.Chromium": "org.chromium.Chromium", "company.thebrowser.Browser": "company.thebrowser.Browser"},
	"linux":   {"google-chrome.desktop": "google-chrome.desktop", "google-chrome-stable.desktop": "google-chrome-stable.desktop", "chromium.desktop": "chromium.desktop", "chromium-browser.desktop": "chromium-browser.desktop", "firefox.desktop": "firefox.desktop", "org.mozilla.firefox.desktop": "org.mozilla.firefox.desktop", "microsoft-edge.desktop": "microsoft-edge.desktop", "brave-browser.desktop": "brave-browser.desktop"},
	"windows": {"ChromeHTML": "Google/Chrome/Application/chrome.exe", "MSEdgeHTM": "Microsoft/Edge/Application/msedge.exe", "FirefoxURL": "Mozilla Firefox/firefox.exe", "BraveHTML": "BraveSoftware/Brave-Browser/Application/brave.exe", "ChromiumHTM": "Chromium/Application/chrome.exe"},
}

func browserFileURL(goos, path string) (string, error) {
	if strings.IndexFunc(path, unicode.IsControl) >= 0 || strings.HasPrefix(path, "//") || strings.HasPrefix(path, `\\`) {
		return "", errors.New("File cannot be opened")
	}
	if goos == "windows" {
		path = strings.ReplaceAll(path, `\`, "/")
		if len(path) < 3 || path[1] != ':' || path[2] != '/' || !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) {
			return "", errors.New("File cannot be opened")
		}
		path = "/" + path
	} else if !strings.HasPrefix(path, "/") {
		return "", errors.New("File cannot be opened")
	}
	// URL.String encodes path delimiters ?/#/% and non-ASCII, keeping no query/fragment.
	return (&url.URL{Scheme: "file", Path: path}).String(), nil
}

func browserFileCommand(goos, id, fileURL, windowsBase string) ([]string, error) {
	known := browserIDs[goos][id]
	if goos == "darwin" {
		for allowed, canonical := range browserIDs[goos] {
			if strings.EqualFold(id, allowed) {
				known = canonical
				break
			}
		}
	}
	// Firefox registers an installation-specific ProgId suffix; only the fixed
	// executable below is used, never its registry command template.
	if goos == "windows" && strings.HasPrefix(id, "FirefoxURL-") && len(id) > len("FirefoxURL-") {
		suffix := strings.TrimPrefix(id, "FirefoxURL-")
		if strings.IndexFunc(suffix, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'A' && r <= 'F' || r >= 'a' && r <= 'f') }) < 0 {
			known = browserIDs[goos]["FirefoxURL"]
		}
	}
	if known == "" {
		return nil, ErrUnknownBrowser
	}
	switch goos {
	case "darwin":
		return []string{"/usr/bin/open", "-b", known, fileURL}, nil
	case "linux":
		return []string{"gtk-launch", known, fileURL}, nil
	case "windows":
		if windowsBase == "" {
			return nil, ErrUnknownBrowser
		}
		return []string{filepath.Join(windowsBase, filepath.FromSlash(known)), fileURL}, nil
	}
	return nil, ErrUnknownBrowser
}

// OpenFileInBrowser opens an already validated canonical local path. The route
// retains responsibility for identity, project bounds, rate and audit logging.
func OpenFileInBrowser(path string) error {
	id, err := defaultBrowserID()
	if err != nil {
		return ErrUnknownBrowser
	}
	u, err := browserFileURL(runtime.GOOS, path)
	if err != nil {
		return err
	}
	bases := []string{""}
	if runtime.GOOS == "windows" {
		bases = []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")}
	}
	for _, base := range bases {
		argv, err := browserFileCommand(runtime.GOOS, id, u, base)
		if err != nil {
			continue
		}
		if runtime.GOOS == "windows" {
			if fi, e := os.Stat(argv[0]); e != nil || !fi.Mode().IsRegular() {
				continue
			}
		}
		if !startOpener(argv) {
			return errors.New("Could not open the file in your browser")
		}
		return nil
	}
	return ErrUnknownBrowser
}
