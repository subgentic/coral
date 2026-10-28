// Package appdownload saves a file the dashboard hands to the native app (#9894).
//
// A native webview drops a download: WKWebView ignores <a download> and blob: addresses (cmd/coral-app has no download delegate), and the
// other webviews show no save dialog either. The app's page script reads the bytes (same-origin, with the window's own session) and passes
// them, base64, to the bound native function, which puts the file in the person's Downloads folder under a safe name that never replaces a
// file already there. The name is a label the page chose: it is cut to a base name and cleaned here, never trusted.
package appdownload

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

// MaxBytes is the most one download may hold (the artifacts' own cap is 25 MiB on the hub; a local file may be larger).
const MaxBytes = 100 << 20

var (
	badChars = regexp.MustCompile(`[:*?"<>|\\/]`)
	reserved = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)`)
)

// SafeName makes a file name from what a page asked for: no path parts, no control or bidi-override characters, none of : * ? " < > |,
// no leading dots, no trailing dots or spaces, a Windows device name prefixed with "_", at most 100 characters, "download" when nothing is left.
func SafeName(name string) string {
	n := name
	if i := strings.LastIndexAny(n, `/\`); i >= 0 {
		n = n[i+1:]
	}
	var b strings.Builder
	for _, r := range n {
		if unicode.IsControl(r) || (r >= 0x200b && r <= 0x200f) || (r >= 0x2028 && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0xfeff {
			continue
		}
		b.WriteRune(r)
	}
	n = badChars.ReplaceAllString(b.String(), "")
	n = strings.TrimLeft(n, ". \t")
	if len([]rune(n)) > 100 {
		n = string([]rune(n)[:100])
	}
	n = strings.TrimRight(n, ". \t")
	if n == "" {
		return "download"
	}
	if reserved.MatchString(n) {
		return "_" + n
	}
	return n
}

// DownloadsDir is the person's Downloads folder (made if it is not there yet).
func DownloadsDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "Downloads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// Save decodes the base64 content and writes it into dir under SafeName(name); a name already taken becomes "name (1).ext", "name (2).ext" and so on
// (the file is created exclusively: an existing file is never replaced). It returns the path written.
func Save(dir, name, contentB64 string) (string, error) {
	if len(contentB64) > MaxBytes*4/3+8 {
		return "", errors.New("that file is too large to save from the app")
	}
	data, err := base64.StdEncoding.DecodeString(contentB64)
	if err != nil {
		return "", fmt.Errorf("the file's content is not valid: %w", err)
	}
	if len(data) > MaxBytes {
		return "", errors.New("that file is too large to save from the app")
	}
	safe := SafeName(name)
	ext := filepath.Ext(safe)
	stem := strings.TrimSuffix(safe, ext)
	for i := 0; i < 1000; i++ {
		candidate := safe
		if i > 0 {
			candidate = fmt.Sprintf("%s (%d)%s", stem, i, ext)
		}
		path := filepath.Join(dir, candidate)
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			if os.IsExist(err) {
				continue
			}
			return "", err
		}
		_, werr := f.Write(data)
		cerr := f.Close()
		if werr != nil || cerr != nil {
			_ = os.Remove(path)
			if werr != nil {
				return "", werr
			}
			return "", cerr
		}
		markDownloaded(path) // the download mark a browser leaves: Gatekeeper and SmartScreen ask before a downloaded app or script runs
		return path, nil
	}
	return "", errors.New("could not find a free file name in Downloads")
}
