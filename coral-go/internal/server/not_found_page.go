package server

import (
	"net/http"
	"strings"
)

// notFoundPageHTML is what a browser gets for a page that is not here (#10281, Mobile pass 20): one line and the way back, where the router's own plain "404 page not found" left a phone with nothing to tap.
// It names no part of the request (a path in a page is how a link becomes a script), and it carries a policy of its own: nothing loads, only its own style applies.
const notFoundPageHTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>Page not found - Coral</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:32rem}h1{font-size:1.4rem;margin:0 0 8px}p{margin:0 0 20px}a{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><h1>Page not found</h1><p>There is no page at this address.</p><a href="/agents">Back to Agents</a></body></html>
`

// notFoundPage answers a miss. A browser asking for a page (GET, accepting HTML, outside the API, the sockets, auth and the static files) gets the page above with its 404; everything else keeps the plain 404 that is not HTML.
func (s *Server) notFoundPage(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	machine := p == "/api" || p == "/ws" || p == "/auth" || p == "/static"
	for _, prefix := range []string{"/api/", "/ws/", "/auth/", "/static/"} {
		if strings.HasPrefix(p, prefix) {
			machine = true
		}
	}
	if r.Method != http.MethodGet || machine || !strings.Contains(r.Header.Get("Accept"), "text/html") {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(notFoundPageHTML))
}
