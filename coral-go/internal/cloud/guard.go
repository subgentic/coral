package cloud

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"

	"github.com/subgentic/coral/pkg/tunnel"
)

// viaSecret is the value the connector stamps in tunnel.ViaHeader: random per
// process, held only in memory, never written or logged. Local processes reach the
// API over loopback too and can send the header themselves, so a request is
// authentically from the connector only when it carries this value
// (TunneledAuthentic). Tunneled stays true for ANY value: everything that only
// tightens for hub requests keeps doing so for a forged stamp.
var viaSecret = func() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("cloud: no randomness for the connector stamp: " + err.Error())
	}
	return hex.EncodeToString(b)
}()

// ViaSecret is the connector stamp for this process (set on LocalHandler.ViaValue).
func ViaSecret() string { return viaSecret }

// TunneledAuthentic reports whether the request really came from this process's
// connector: its stamp matches the per-process secret (constant-time compare).
// Use it where the hub path GRANTS something (auto-accept enable); a present but
// wrong stamp is a forgery.
func TunneledAuthentic(r *http.Request) bool {
	v := r.Header.Get(tunnel.ViaHeader)
	return v != "" && subtle.ConstantTimeCompare([]byte(v), []byte(viaSecret)) == 1
}

// Tunneled reports whether the request was executed by the connector for the Cloud
// Hub. LocalHandler stamps tunnel.ViaHeader on every request it forwards, after
// scrubbing hub headers, so the hub can neither send nor clear it.
func Tunneled(r *http.Request) bool { return r.Header.Get(tunnel.ViaHeader) != "" }

// ServiceAsker is who the Coral Hub's own service says a read is for, when the request is a stream this process's connector really stamped for the service (#7364, tunnel/hubservice.go): the
// connector's per-process stamp, the service flag and a well formed asker (the server and board the request was sent from). A user's stream, a forged stamp and a half stamp are not one.
// The connector sets the service headers only on a service route of a stream that carries the whole stamp, after removing whatever the request brought under those names; this process
// honours them only beside the connector's secret, which no user, agent or local program holds.
func ServiceAsker(r *http.Request) (tunnel.HubAsker, bool) {
	if !TunneledAuthentic(r) || r.Header.Get(tunnel.HubServiceHeader) != "1" {
		return tunnel.HubAsker{}, false
	}
	a := tunnel.HubAsker{Server: r.Header.Get(tunnel.HubAskServerHeader), Board: r.Header.Get(tunnel.HubAskBoardHeader)}
	return a, tunnel.ValidHubAsker(a)
}

// GuardRefusedCode is the closed code of the Guard's 403, so a caller can tell the policy's refusal from a handler's (#9084).
const GuardRefusedCode = "hub_route_refused"

// Guard is the server-side half of the route policy. The connector already refuses
// anything outside the shared route table (pkg/tunnel) or above the local maximum
// mode before it reaches the local API; Guard repeats the decision, query string
// included, for every request that carries tunnel.ViaHeader, so the policy holds even if
// the connector's own check were bypassed or had a bug. Requests without the header
// (the local dashboard, API keys, agents) are untouched.
//
// A user's request is judged by the user table (tunnel.Classify). A request that is the Hub's own service stream, authentically stamped (ServiceAsker), is judged by the service table
// (tunnel.ClassifyService) instead, as the connector judged it: the service routes are never a user's, so the user table refuses them (#9084).
func Guard(maxMode func() tunnel.Mode) func(http.Handler) http.Handler {
	allow := tunnel.AllowRequest(maxMode)
	allowService := tunnel.AllowServiceRequest(maxMode)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if Tunneled(r) && !allow(r.Method, r.URL.Path, r.URL.RawQuery) {
				if _, service := ServiceAsker(r); !service || !allowService(r.Method, r.URL.Path, r.URL.RawQuery) {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusForbidden)
					_, _ = w.Write([]byte(`{"error":"not available through the Coral Hub in this access mode","code":"` + GuardRefusedCode + `"}`))
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}
