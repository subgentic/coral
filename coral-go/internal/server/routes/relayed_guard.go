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

// With the local switch hub_require_trusted_device on (#21883), every kind of devicekey.KindRoutes is required, not only relayedRequired: a request on one of its routes with no signature is refused 403 device_required before any handler.
//
// RelayedGuard is the guard, after the link stamp and before the grant check. verifier is the computer's one device verifier (nil when there is none); ownerLabel is the owner label confirmed for the link the
// request came through, "" when none.
func RelayedGuard(verifier func() *devicekey.Verifier, ownerLabel func(context.Context) (string, error), requireDevice func(context.Context) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			via, tunneled := cloud.ViaFrom(r.Context())
			if !tunneled {
				next.ServeHTTP(w, r)
				return
			}
			target := r.URL.RequestURI()
			kind, listed := devicekey.KindOfRoute(r.Method, target)
			on := requireDevice != nil && requireDevice(r.Context())
			if !listed && on { // the local switch (#21883): every other write the Hub carries is the one generic kind, hub-write, except the few the Hub itself sends with no person
				switch {
				case devicekey.IsHubWrite(r.Method, target):
					kind, listed = devicekey.HubWrite, true
				case devicekey.HubWriteExempt(r.Method, target):
					if !hubWriteExemptAuthority(r, via) {
						deviceMsgLimiter.failed(via.LinkID+"|required", time.Now())
						slog.Info("[device] an exempt Hub write without its own authority was refused: this computer requires a trusted device", "link", via.LinkID, "path", devicekey.RoutePath(target))
						deviceReply(w, devicekey.ErrDeviceRequired)
						return
					}
					if isAuthenticRelay(r) {
						slog.Info("[device] a cross-team relay was accepted while this computer requires a trusted device", "link", via.LinkID, "path", devicekey.RoutePath(target))
					}
				}
			}
			if !listed {
				next.ServeHTTP(w, r)
				return
			}
			any, whole := relayedHeaders(r)
			now := time.Now()
			required := relayedRequired[kind] || on // the local switch: every listed kind is required (#21883)
			if !any && !required {
				next.ServeHTTP(w, r)
				return
			}
			if !any && required && !relayedRequired[kind] { // the switch refuses it, with a reply that says nothing about which devices exist; one line per link, rate limited with the other refusals
				deviceMsgLimiter.failed(via.LinkID+"|required", now)
				slog.Info("[device] a relayed request without a signature was refused: this computer requires a trusted device", "link", via.LinkID)
				deviceReply(w, devicekey.ErrDeviceRequired)
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
			if _, err := v.Store.ActiveDeviceKey(r.Context(), kid, now); err == nil {
				key = via.LinkID + "|" + kid // a listed kid has its own budget; every invented one shares "unknown"
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
				KID: kid, Sig: r.Header.Get(tunnel.DeviceSigHeader), Ts: r.Header.Get(tunnel.DeviceTsHeader), Nonce: r.Header.Get(tunnel.DeviceNonceHeader), Body: body, RequireTrusted: on}, pin, now)
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

// hubWriteExemptAuthority says whether a write of devicekey's hubWriteExempt list has the authority that admits it with no signature (#21883). The device-keys message and certificate carry their own signature in the body and
// read no Hub header. guide-revoked is the Hub's own service stream, never a person. A cross-team relay is another Coral's, stamped by the connector with a source server and no Hub person. hub-notice is the
// Hub's fixed template, stamped by the connector with the notice header. Anything else on those routes (a person's request, a forged stamp) is an unsigned write and is refused.
func hubWriteExemptAuthority(r *http.Request, via cloud.Via) bool {
	path := devicekey.RoutePath(r.URL.RequestURI())
	switch {
	case path == "/api/device-keys/message" || path == "/api/device-keys/certificate":
		return true
	case path == "/api/cloud/guide-revoked":
		_, ok := cloud.ServiceAsker(r)
		return ok && via.HubUser == ""
	case isAuthenticRelay(r):
		return via.HubUser == ""
	case isAuthenticHubNotice(r):
		return via.HubUser == ""
	}
	return false
}
