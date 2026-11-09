package server

import (
	"io/fs"
	"net/http"
)

// serveArtifactHost serves the host document with its own response headers: never the dashboard's policy, never cached.
func serveArtifactHost(staticFS fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", artifactHostCSP)
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-DNS-Prefetch-Control", "off")
		h.Set("Permissions-Policy", artifactHostPermissions)
		http.ServeFileFS(w, r, staticFS, "static/artifact_host.html")
	}
}

// artifactHostCSP is the response policy of /static/artifact_host.html, the document that runs an HTML file the person chose to trust
// (#14730, design v3). The dashboard frames it with sandbox="allow-scripts" (an opaque origin); the policy lets it run inline script, draw
// with data: and blob: images and fonts, and open ONE about: child frame (the file's own); it makes no request of any kind
// (connect-src 'none', no form, no base, no object) and cannot be framed by another site. The same words are the header on the child
// frame, except frame-src 'none'. The test pins every directive; weakening one is a decision for Security.
const artifactHostCSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
	"connect-src 'none'; frame-src about:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts"

// artifactHostPermissions turns off every device and feature the browser would otherwise offer a page.
const artifactHostPermissions = "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), " +
	"fullscreen=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), " +
	"screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()"
