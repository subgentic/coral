package routes

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/pkg/hubproxy"
)

// setUntrustedContentHeaders prepares a response whose bytes an agent, a repo
// or a remote controls (an uploaded artifact, a workflow step file), served
// from the dashboard's own origin.
//
// Whatever its type, the response is sandboxed (an opaque origin with no
// script) and never sniffed, and anything that is not inert media or plain data
// (HTML, SVG, XML, JavaScript, PDF, unknown types) downloads instead of opening
// when someone follows its link. The real media type is kept: the preview pane
// fetches these URLs and picks its renderer from it, and fetch and <img>
// ignore Content-Disposition.
func setUntrustedContentHeaders(h http.Header, contentType, filename string) {
	mt, params, err := mime.ParseMediaType(contentType)
	mt = strings.ToLower(mt)
	known := err == nil && mt != ""
	if !known {
		mt, params = "application/octet-stream", nil
	}
	if ct := mime.FormatMediaType(mt, params); ct != "" {
		h.Set("Content-Type", ct)
	} else {
		h.Set("Content-Type", mt)
	}
	if known && hubproxy.InlineSafe(mt) {
		h.Set("Content-Disposition", hubproxy.Disposition("inline", filename))
	} else {
		h.Set("Content-Disposition", hubproxy.Disposition("attachment", filename))
	}
	h.Set("X-Content-Type-Options", "nosniff")
	if mt == "text/html" || mt == "application/xhtml+xml" {
		h.Set("Content-Security-Policy", hubproxy.PreviewCSP) // its inline styles apply (#3593)
	} else {
		h.Set("Content-Security-Policy", hubproxy.SandboxCSP)
	}
}

// artifactURL is the dashboard path for a managed artifact. The ?v=2 form is new in v1.4.12:
// before it the bare path was served inline without a sandbox and cached for a year, so links
// handed out from now on never match such a cache entry. The bare path still works.
func artifactURL(digest string) string { return "/api/artifacts/" + digest + "?v=2" }

// serveArtifactToRead answers the viewer's Open in new tab (?open=1, #11836): a tab that shows the file, where the plain link downloads
// every type that is not inert media or plain data (HTML, SVG, XML, JavaScript, PDF, Markdown, CSV, unknown). It reports whether it answered;
// false leaves the caller to serve the link as before (inert media is shown inline already). Nothing here runs on the dashboard's origin:
//   - a PDF is shown by the browser's viewer (its own origin), with no script or sub-resource allowed to the page;
//   - Markdown is rendered by renderMarkdownSafe into a page of its own under a sandbox with no script; any other text, whatever its declared type (HTML and SVG included), is served as text/plain: its source, never rendered, under the sandbox;
//   - a binary file gets a one-line note that says so (Download is the way to save it).
//
// maxRenderedMarkdown is the largest Markdown file the new tab renders; a bigger one is shown as its source.
const maxRenderedMarkdown = 2 << 20

func serveArtifactToRead(w http.ResponseWriter, r *http.Request, f io.ReadSeeker, contentType, filename string, size int64) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	mt = strings.ToLower(mt)
	if err == nil && mt != "" && hubproxy.InlineSafe(mt) {
		return false
	}
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	h.Del("X-Coral-Build")
	if mt == "application/pdf" {
		h.Set("Content-Type", "application/pdf")
		h.Set("Content-Disposition", hubproxy.Disposition("inline", filename))
		h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
		http.ServeContent(w, r, "", time.Time{}, f)
		return true
	}
	if (mt == "text/markdown" || mt == "text/x-markdown") && size <= maxRenderedMarkdown { // rendered, as its own response: the page is built here from escaped text and served under the sandbox with no script (markdown_open.go, #11845)
		if raw, err := io.ReadAll(io.LimitReader(f, maxRenderedMarkdown+1)); err == nil && int64(len(raw)) <= maxRenderedMarkdown && utf8.Valid(raw) {
			h.Set("Content-Type", "text/html; charset=utf-8")
			h.Set("Content-Disposition", hubproxy.Disposition("inline", filename))
			h.Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
			_, _ = io.WriteString(w, markdownPage(filename, renderMarkdownSafe(string(raw))))
			return true
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return false
		}
	}
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set("Content-Disposition", hubproxy.Disposition("inline", filename))
	h.Set("Content-Security-Policy", hubproxy.SandboxCSP)
	head := make([]byte, 4096)
	n, _ := io.ReadFull(f, head)
	head = head[:n]
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return false
	}
	if looksLikeText(head) {
		http.ServeContent(w, r, "", time.Time{}, f)
		return true
	}
	shown := mt
	if shown == "" || err != nil {
		shown = "unknown type"
	}
	shown = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, shown)
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "This file is binary (%s, %d bytes) and has no readable view. Use Download to save it.\n", shown, size)
	return true
}
