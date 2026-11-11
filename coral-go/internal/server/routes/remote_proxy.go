package routes

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	proxy "github.com/subgentic/coral/pkg/hubproxy"
)

// MountRemoteProxy registers the multi-server hub proxy on r:
//
//	/api/remote/{server}/*  ->  {remote url}/*   (HTTP, SSE and WebSocket)
//
// resolver maps a server id to its URL and decrypted key (see proxy.Resolver);
// if it also implements proxy.StatusReporter, proxy failures update the
// server's status. The route must be registered behind the hub's normal auth
// middleware.
func MountRemoteProxy(r chi.Router, resolver proxy.Resolver) http.Handler {
	h := proxy.New(resolver)
	r.Handle("/api/remote/{server}/*", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		req = proxyContext(req) // the person signed in at THIS hub may have the decisions that need a person signed (#11378); the widened routes only for a real sign-in session (#13694, #13725)
		h.ServeHTTP(w, req)
	}))
	return h
}
