package devicekey

import (
	"encoding/base64"
	"net/url"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// PairingQRPNG renders a live hold without returning its secret as text. A caller
// supplies only its own validated pending link. Nothing is retained beyond the hold.
func (h *SecretHold) PairingQRPNG(link string, now time.Time) []byte {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if !now.Before(h.expires) {
		h.die()
		return nil
	}
	if !h.aliveLocked(now) {
		return nil
	}
	u, err := url.Parse(link)
	if err != nil || u.User != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil
	}
	u.Fragment = "p=" + base64.RawURLEncoding.EncodeToString(h.secret)
	png, err := qrcode.Encode(u.String(), qrcode.Medium, 256)
	if err != nil {
		return nil
	}
	return png
}

// QRExpiresAt is safe lifetime metadata, never the secret. A dead hold has no QR.
func (h *SecretHold) QRExpiresAt(now time.Time) time.Time {
	if h == nil {
		return time.Time{}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if !now.Before(h.expires) {
		h.die()
		return time.Time{}
	}
	if !h.aliveLocked(now) {
		return time.Time{}
	}
	return h.expires
}
