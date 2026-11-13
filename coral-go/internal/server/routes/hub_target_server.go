package routes

import (
	"context"
	"net/http"
	"strings"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// HubTargetGuard keeps a send, keys or answer-prompt that came through Coral Hub from being typed into an agent of the wrong computer (#16032, coral-hub Security). The hub routes by server id alone, so when two
// computers share an agent name a request under the wrong id would reach the other one's agent. The hub names the server it routed to in X-Coral-Hub-Server (the connector forwards it on these three routes only);
// this computer compares it with its own Coral Hub server id and refuses (409 hub_wrong_server) anything else: another id, a repeated or empty header, or an id it cannot compare because it does not know its own.
// A request without the header (a hub that does not send it yet) is let through, as is every request that did not come through the hub (the dashboard on this computer; a header it sent is not read).
func HubTargetGuard(own func(context.Context) (string, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !cloud.Tunneled(r) {
				next.ServeHTTP(w, r)
				return
			}
			vals := r.Header.Values(tunnel.HubServerHeader)
			if len(vals) == 0 {
				next.ServeHTTP(w, r)
				return
			}
			named := ""
			if len(vals) == 1 {
				named = strings.TrimSpace(vals[0])
			}
			mine := ""
			if own != nil {
				mine, _ = own(r.Context())
			}
			if named == "" || mine == "" || !strings.EqualFold(named, mine) {
				writeJSON(w, http.StatusConflict, map[string]any{"error": "this request was routed to another computer, so nothing was typed", "code": "hub_wrong_server"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
