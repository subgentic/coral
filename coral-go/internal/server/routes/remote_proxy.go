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
func MountRemoteProxy(r chi.Router, resolver proxy.Resolver) {
	h := proxy.New(resolver)
	r.Handle("/api/remote/{server}/*", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// The person signed in at THIS hub (the identity layer's humanInputCaller: a dashboard session or this computer's own same-origin browser, never an API key or an agent token) may have the decisions that
		// need a person signed (#11378). The proxy signs only the two allowlisted routes and only for a target that holds a secret.
		if humanInputCaller(req) {
			req = req.WithContext(proxy.WithSignedInOwner(req.Context()))
		}
		h.ServeHTTP(w, req)
	}))
}
