package routes

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The relayed (v3) signed requests (#20879, goal #269; coral-hub's signer agreed at #267139). A request a Hub carries on a route of devicekey.KindRoutes may bring the four Coral-Device-* headers: this computer rebuilds
// the signed text from its own state and verifies it (devicekey.HandleRelayedRequest) BEFORE any handler runs, and spends the nonce there. Nothing the Hub or the browser says about who signed or for whom is read: the
// link and the Hub person come from the connector's own stamp, the computer from its own key, the method and URI and the body from what arrived. A verified request goes on unchanged (no tier is raised by it); a bad
// one is refused with the closed reply code and nothing else; a request with none of the headers is not touched. A request that did not come through the connector, and one on a route no kind lists, are never read.

// relayedRequired are the kinds whose request must carry the signature: without it the guard refuses (bad_form), where for the others a request with none of the headers goes on untouched. Giving or ending a member's
// access (#20883) is one: a Hub request for it with no signature is never a local request and never a grant. The handler asks again (RelayedFrom), so removing either check still leaves the route refused.
var relayedRequired = map[devicekey.Kind]bool{devicekey.GrantMember: true, devicekey.AllowLink: true, devicekey.MakeLinkKey: true, devicekey.RevokeLinkKey: true, devicekey.DenyLink: true}

// RelayedGuard is the guard, after the link stamp and before the grant check. verifier is the computer's one device verifier (nil when there is none); ownerLabel is the owner label confirmed for the link the
// request came through, "" when none.
func RelayedGuard(verifier func() *devicekey.Verifier, ownerLabel func(context.Context) (string, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			via, tunneled := cloud.ViaFrom(r.Context())
			if !tunneled {
				next.ServeHTTP(w, r)
				return
			}
			target := r.URL.RequestURI()
			kind, listed := devicekey.KindOfRoute(r.Method, target)
			if !listed {
				next.ServeHTTP(w, r)
				return
			}
			any, whole := relayedHeaders(r)
			now := time.Now()
			if !any && !relayedRequired[kind] {
				next.ServeHTTP(w, r)
				return
			}
			refuse := func(key string, err error) {
				deviceMsgLimiter.failed(key, now)
				slog.Info("[device] a relayed signed request was refused", "code", devicekey.ReplyCode(err))
				deviceReply(w, err)
			}
			if !whole {
				refuse(via.LinkID+"|form", devicekey.ErrBadForm)
				return
			}
			v := verifier()
			if v == nil {
				deviceReply(w, errors.New("no verifier"))
				return
			}
			kid := r.Header.Get(tunnel.DeviceKeyHeader)
			key := via.LinkID + "|unknown"
			certHeader := r.Header.Get(tunnel.DeviceCertHeader)
			if _, err := v.Store.ActiveDeviceKey(r.Context(), kid, now); err == nil {
				key = via.LinkID + "|" + kid // a listed kid has its own budget; every invented one shares "unknown"
			} else if certHeader != "" {
				key = via.LinkID + "|cert" // browsers that bring a certificate share one budget of their own, so they never take the owner's keys' or the unknown bucket's (#21889)
			}
			if len(r.Header.Values(tunnel.DeviceCertHeader)) > 1 { // a second certificate is never read (the connector already drops it)
				refuse(key, devicekey.ErrBadForm)
				return
			}
			if !deviceMsgLimiter.allow(key, now) {
				deviceReply(w, errors.New("rate limited"))
				return
			}
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, devicekey.RelayedBodyMax))
			if err != nil {
				refuse(key, devicekey.ErrBodyTooLarge)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			pin := func(string) (string, bool) {
				label, err := ownerLabel(r.Context())
				return label, err == nil && label != ""
			}
			m, err := v.HandleRelayedRequest(r.Context(), devicekey.RelayedRequest{Link: via.LinkID, HubUser: via.HubUser, Method: r.Method, Target: target,
				KID: kid, Sig: r.Header.Get(tunnel.DeviceSigHeader), Ts: r.Header.Get(tunnel.DeviceTsHeader), Nonce: r.Header.Get(tunnel.DeviceNonceHeader), Cert: certHeader, Body: body}, pin, now)
			if err != nil {
				refuse(key, err)
				return
			}
			next.ServeHTTP(w, r.WithContext(devicekey.WithRelayed(r.Context(), m)))
		})
	}
}

// relayedHeaders says whether the request carries any of the four headers and whether it carries exactly one value of each (the connector already removes a half or an oversized set; a repeated header is never one it makes).
func relayedHeaders(r *http.Request) (any, whole bool) {
	whole = true
	for _, n := range tunnel.DeviceHeaders {
		vs := r.Header.Values(n)
		if len(vs) > 0 {
			any = true
		}
		if len(vs) != 1 || vs[0] == "" {
			whole = false
		}
	}
	return any, whole
}
